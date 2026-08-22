/**
 * 搜索工具: search_files, everything_search, grep_content
 */

import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { type EsExeResolution, resolveEsExe } from "../es-integrity.js";
import { logger } from "../logger.js";
import { escapePsString, IS_WIN } from "../platform.js";
import { getRegex } from "../regex.js";
import { ErrorCode, fail, success, withErrorSchema } from "../result.js";
import { validatePath } from "../security.js";
import { buildShellInvocation, getShellSpec } from "../shell.js";
import { wrapHandler } from "../wrap.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 将 Everything resolver 的失败转换为搜索工具可消费的结构化错误。 */
function esResolutionFailure(resolution: Extract<EsExeResolution, { available: false }>, toolName: string) {
  const { diagnostic } = resolution;
  const explicit = resolution.source === "explicit";
  const configurationError = explicit && toolName === "search_files";
  return fail(
    configurationError ? ErrorCode.VALIDATION_ERROR : ErrorCode.EXECUTION_FAILED,
    explicit
      ? `Configured ${diagnostic.env_name} is not usable (${diagnostic.reason})`
      : `Everything CLI is unavailable (${diagnostic.reason})`,
    {
      retryable: false,
      param: explicit ? diagnostic.env_name : undefined,
      suggestion: explicit
        ? `Fix ${diagnostic.env_name} or unset it and retry; the configured path will not silently fall back.`
        : toolName === "everything_search"
          ? `Use search_files, or provide a verified es.exe through ${diagnostic.env_name} or ${diagnostic.default_path}.`
          : `Use native search fallback; provide a verified es.exe through ${diagnostic.env_name} or ${diagnostic.default_path}.`,
      detail: diagnostic,
    },
  );
}

/** 将 glob 模式（* 和 ?）转换为不区分大小写的正则 */
export function globToRegex(pattern: string): RegExp {
  const regexStr =
    "^" +
    pattern
      .replace(/[\\^$+{}.()|[\]-]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  return new RegExp(regexStr, "i");
}

export function registerSearchTools(server: McpServer) {
  // ====================================================================
  const SearchFilesInput = z.object({
    dir_path: z.string().describe("Directory to search in"),
    pattern: z.string().describe("Filename pattern, e.g. *.ts, *.log, test*"),
    max_depth: z.number().optional().describe("Max search depth for native fallback, default 5"),
    max_results: z.number().optional().describe("Max results, default 50"),
  });
  type SearchFilesInput = z.infer<typeof SearchFilesInput>;

  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description:
        "Search for files by name pattern. Auto-starts Everything engine for instant results on Windows, falls back to native search.",
      inputSchema: SearchFilesInput,
      outputSchema: withErrorSchema(
        z.object({
          matches: z.array(z.string()),
          total: z.number(),
          search_ms: z.number(),
          truncated: z.boolean(),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("search_files", async ({ dir_path, pattern, max_depth, max_results }: SearchFilesInput) => {
      const pathErr = validatePath(dir_path, "search_files");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_path" });
      const t0 = Date.now();
      const maxR = max_results || 50;
      const matches: string[] = [];

      try {
        if (IS_WIN) {
          try {
            const resolution = await resolveEsExe();
            if (!resolution.available) {
              if (resolution.source === "explicit") return esResolutionFailure(resolution, "search_files");
              logger.debug("search_files", "everything-skipped", resolution.diagnostic.reason);
            } else {
              const esPath = resolution.path;
              const normalizedDir = resolve(dir_path).toLowerCase();
              await new Promise<void>((done) => {
                const args = ["-s", "-n", String(maxR * 2), pattern];
                execFile(
                  esPath,
                  args,
                  { maxBuffer: 10 * 1024 * 1024, timeout: 10000 },
                  (_err: unknown, stdout: string) => {
                    if (stdout) {
                      for (const l of stdout.split("\n")) {
                        const trimmed = l.trim();
                        if (trimmed?.toLowerCase().startsWith(normalizedDir)) {
                          matches.push(trimmed);
                          if (matches.length >= maxR) break;
                        }
                      }
                    }
                    done();
                  },
                );
              });
            }
          } catch (err) {
            logger.debug("search_files", "everything-fallback", String(err));
          }
        }

        if (matches.length === 0) {
          const maxD = max_depth || 5;
          const reg = globToRegex(pattern);

          async function walk(p: string, d: number) {
            if (d > maxD || matches.length >= maxR) return;
            try {
              const entries = await readdir(p, { withFileTypes: true });
              for (const e of entries) {
                if (matches.length >= maxR) break;
                const fp = join(p, e.name);
                if (e.isDirectory()) {
                  if (!e.name.startsWith(".")) await walk(fp, d + 1);
                } else if (reg.test(e.name)) matches.push(fp);
              }
            } catch (e) {
              logger.warn("search_files", "walk-error", `${p}: ${String(e)}`);
            }
          }
          await walk(dir_path, 0);
        }

        const ms = Date.now() - t0;
        logger.info("search_files", "done", `${matches.length} matches in ${ms}ms`);
        return success(
          `Found ${matches.length} file(s) in ${ms}ms:\n${matches.join("\n")}`,
          { matches, total: matches.length, search_ms: ms, truncated: matches.length >= maxR },
          { truncated: matches.length >= maxR, latency_ms: ms },
        );
      } catch (e: unknown) {
        return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: true });
      }
    }),
  );

  // ====================================================================
  const EverythingSearchInput = z.object({
    query: z
      .string()
      .describe("Everything search query. Supports: wildcards(*.txt), regex, path:, size:, date: filters"),
    dir_filter: z.string().optional().describe("Optional: limit search to this directory path"),
    max_results: z.number().optional().describe("Max results, default 100"),
  });
  type EverythingSearchInput = z.infer<typeof EverythingSearchInput>;

  server.registerTool(
    "everything_search",
    {
      title: "Everything Search",
      description: "Ultra-fast full-disk file search powered by Everything engine (Windows only).",
      inputSchema: EverythingSearchInput,
      outputSchema: withErrorSchema(
        z.object({ matches: z.array(z.string()), total: z.number(), search_ms: z.number() }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("everything_search", async ({ query, dir_filter, max_results }: EverythingSearchInput) => {
      if (dir_filter) {
        const pathErr = validatePath(dir_filter, "everything_search");
        if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_filter" });
      }
      const t0 = Date.now();
      const maxR = max_results || 100;

      if (!IS_WIN) {
        return fail(ErrorCode.EXECUTION_FAILED, "Everything search is only available on Windows", {
          retryable: false,
          suggestion: "Use search_files instead",
        });
      }

      try {
        const resolution = await resolveEsExe();
        if (!resolution.available) return esResolutionFailure(resolution, "everything_search");
        const esPathWin = resolution.path;
        const results: string[] = [];

        await new Promise<void>((resolve) => {
          const args = ["-s", "-n", String(maxR)];
          if (dir_filter) args.push("-path", dir_filter);
          args.push(query);
          execFile(esPathWin, args, { maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (_e: unknown, stdout: string) => {
            if (stdout)
              results.push(
                ...stdout
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l),
              );
            resolve();
          });
        });

        const ms = Date.now() - t0;
        return success(`[Everything ${ms}ms] Found ${results.length} file(s):\n${results.join("\n")}`, {
          matches: results,
          total: results.length,
          search_ms: ms,
        });
      } catch (e: unknown) {
        return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: true });
      }
    }),
  );

  // ====================================================================
  const GrepContentInput = z.object({
    dir_path: z.string().describe("Directory to search in"),
    pattern: z.string().describe("Regex pattern to search for in file contents"),
    file_pattern: z.string().optional().describe("File name filter, e.g. *.ts, default *"),
    max_results: z.number().optional().describe("Max matching lines, default 50"),
  });
  type GrepContentInput = z.infer<typeof GrepContentInput>;

  server.registerTool(
    "grep_content",
    {
      title: "Grep Content",
      description: "Search file contents using regex pattern. Uses PowerShell Select-String on Windows, grep on Unix.",
      inputSchema: GrepContentInput,
      outputSchema: withErrorSchema(
        z.object({ matches: z.array(z.string()), total: z.number(), search_ms: z.number() }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("grep_content", async ({ dir_path, pattern, file_pattern, max_results }: GrepContentInput) => {
      const pathErr = validatePath(dir_path, "grep_content");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_path" });
      // 主路径预检 pattern：语法 + ReDoS 防护（与 fallback 路径统一）
      try {
        getRegex(pattern, "gi");
      } catch (e: unknown) {
        return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: false, param: "pattern" });
      }
      const t0 = Date.now();
      const maxR = max_results || 50;
      const fileFilter = file_pattern || "*";
      const results: string[] = [];

      try {
        // PS 入口仅在解析到 PowerShell flavor 时启用；cmd 模式或解析失败走原生降级
        const shellSpec = await getShellSpec().catch(() => null);
        if (IS_WIN && shellSpec && (shellSpec.flavor === "pwsh" || shellSpec.flavor === "powershell")) {
          const execAsync = promisify(execFile);
          // 参数内联进单引号字面量（'' 转义），避免拼接注入
          const q = (s: string) => `'${escapePsString(s)}'`;
          const psScript = [
            "$ErrorActionPreference = 'SilentlyContinue';",
            `Get-ChildItem -LiteralPath ${q(dir_path)} -Filter ${q(fileFilter)} -Recurse -File |`,
            `  Select-String -Pattern ${q(pattern)} |`,
            `  Select-Object -First ${maxR} |`,
            '  ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }',
          ].join(" ");
          try {
            const inv = buildShellInvocation(psScript, shellSpec);
            const { stdout } = await execAsync(inv.file, inv.args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
            results.push(
              ...stdout
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l),
            );
          } catch (e: unknown) {
            logger.warn("grep_content", "ps-error", String(e));
            return fail(ErrorCode.EXECUTION_FAILED, `PowerShell grep failed: ${errMsg(e)}`, {
              retryable: true,
              detail: { dir_path, file_pattern: fileFilter, pattern },
            });
          }
        }

        if (!IS_WIN && results.length === 0) {
          try {
            const execAsync = promisify(execFile);
            const grepArgs = ["-rnI", `--include=${fileFilter}`, pattern, dir_path];
            const { stdout } = await execAsync("grep", grepArgs, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
            results.push(
              ...stdout
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l)
                .slice(0, maxR),
            );
          } catch (e: unknown) {
            const rawOut = (e as { stdout?: unknown }).stdout;
            const stdout =
              typeof rawOut === "string"
                ? rawOut
                : rawOut != null && typeof (rawOut as { toString?: () => string }).toString === "function"
                  ? String((rawOut as { toString: () => string }).toString())
                  : "";
            const code = (e as { code?: unknown }).code;
            if (code === 1 && !stdout) {
              logger.debug("grep_content", "grep-no-matches", `${dir_path} ${pattern}`);
            } else if (stdout) {
              results.push(
                ...stdout
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l)
                  .slice(0, maxR),
              );
            } else {
              logger.warn("grep_content", "grep-error", String(e));
              return fail(ErrorCode.EXECUTION_FAILED, `grep failed: ${errMsg(e)}`, {
                retryable: true,
                detail: { dir_path, file_pattern: fileFilter, pattern },
              });
            }
          }
        }

        if (results.length === 0) {
          let regex: RegExp;
          try {
            regex = getRegex(pattern, "gi");
          } catch (e: unknown) {
            return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: false, param: "pattern" });
          }
          const fileRegex = globToRegex(fileFilter);

          async function grepFile(fp: string) {
            const rl = createInterface({ input: createReadStream(fp, { encoding: "utf-8" }), crlfDelay: Infinity });
            let lineNum = 0;
            for await (const line of rl) {
              if (results.length >= maxR) {
                rl.close();
                break;
              }
              lineNum++;
              if (regex.test(line)) results.push(`${fp}:${lineNum}: ${line.trim()}`);
              regex.lastIndex = 0;
            }
          }

          async function walk(p: string, depth: number) {
            if (depth > 5 || results.length >= maxR) return;
            try {
              const entries = await readdir(p, { withFileTypes: true });
              for (const entry of entries) {
                if (results.length >= maxR) break;
                const fp = join(p, entry.name);
                if (entry.isFile() && fileRegex.test(entry.name)) {
                  try {
                    await grepFile(fp);
                  } catch (e) {
                    logger.warn("grep_content", "grep-file-error", `${fp}: ${String(e)}`);
                  }
                } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
                  await walk(fp, depth + 1);
                }
              }
            } catch (e) {
              logger.warn("grep_content", "walk-error", `${p}: ${String(e)}`);
            }
          }
          await walk(dir_path, 0);
        }

        const ms = Date.now() - t0;
        logger.info("grep_content", "done", `${results.length} matches in ${ms}ms`);
        return success(`Found ${results.length} match(es) in ${ms}ms:\n${results.join("\n")}`, {
          matches: results,
          total: results.length,
          search_ms: ms,
        });
      } catch (e: unknown) {
        return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: true });
      }
    }),
  );
}
