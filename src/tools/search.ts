/**
 * 搜索工具: search_files, everything_search, grep_content
 */

import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { type EsExeResolution, resolveEsExe } from "../es-integrity.js";
import { type FdResolution, resolveFd } from "../fd-resolver.js";
import { boundedString, finiteInt, type RequestContext } from "../hardening-contract.js";
import { logger } from "../logger.js";
import { nativeGrepContent, nativeSearchFiles } from "../native-search.js";
import {
  assertIntRange,
  assertStringBounded,
  pushWarning,
  SEARCH_BUDGET,
  type SearchWarning,
  searchWarningSchema,
  WARNING_CODES,
} from "../partial-result.js";
import { escapePsString, IS_WIN } from "../platform.js";
import { execFileManaged, ManagedProcessError } from "../process-supervisor.js";
import { getRegex } from "../regex.js";
import { ErrorCode, Errors, fail, success, withErrorSchema } from "../result.js";
import { validatePath } from "../security.js";
import { buildShellInvocation, getShellSpec } from "../shell.js";
import { registerManagedTool } from "../tool-registry.js";
import { wrapHandler } from "../wrap.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 将 fd resolver 的显式失败转换为结构化错误（fail-closed，不落兜底；隐式不可用由调用方走原生兜底）。 */
function fdResolutionFailure(resolution: Extract<FdResolution, { available: false }>) {
  const { diagnostic } = resolution;
  return fail(ErrorCode.VALIDATION_ERROR, `Configured ${diagnostic.env_name} is not usable (${diagnostic.reason})`, {
    retryable: false,
    param: diagnostic.env_name,
    suggestion: `Fix ${diagnostic.env_name} or unset it and retry; the configured path will not silently fall back.`,
    detail: diagnostic,
  });
}

/** 构造 fd 搜索参数：glob 语义/大小写/忽略规则对齐 native walk，pattern 与目录走 argv 数组（-- 终止选项解析），无 shell 拼接 */
export function buildFdArgs(pattern: string, dirPath: string, maxResults: number, maxDepth?: number): string[] {
  const args = [
    "--color=never",
    "--absolute-path",
    "--glob",
    "--ignore-case",
    "--no-ignore",
    "--max-results",
    String(maxResults),
  ];
  // 引擎路径默认全树（对齐 Everything）；仅用户显式传 max_depth 时下发
  if (maxDepth !== undefined) args.push("--max-depth", String(maxDepth));
  args.push("--", pattern, dirPath);
  return args;
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
          ? `Use search_files, or provide an es.exe you installed through ${diagnostic.env_name} or ${diagnostic.default_path}.`
          : `Use native search fallback; provide an es.exe you installed through ${diagnostic.env_name} or ${diagnostic.default_path}.`,
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
    pattern: boundedString(SEARCH_BUDGET.patternMaxChars, SEARCH_BUDGET.patternMaxBytes).describe(
      "Filename pattern, e.g. *.ts, *.log, test*",
    ),
    max_depth: finiteInt(1, SEARCH_BUDGET.maxDepth)
      .optional()
      .describe(
        "Max search depth for native fallback, default 5; engine paths (Everything/fd) search the full tree unless explicitly set",
      ),
    max_results: finiteInt(1, SEARCH_BUDGET.searchFilesMaxResults).optional().describe("Max results, default 50"),
  });
  type SearchFilesInput = z.infer<typeof SearchFilesInput>;

  registerManagedTool(
    server,
    "search_files",
    {
      title: "Search Files",
      description:
        "Search for files by name pattern. Auto-starts Everything engine for instant results on Windows, uses fd when available on Linux/macOS, falls back to native search.",
      inputSchema: SearchFilesInput,
      outputSchema: withErrorSchema(
        z.object({
          matches: z.array(z.string()),
          total: z.number(),
          search_ms: z.number(),
          truncated: z.boolean(),
          complete: z.boolean(),
          warnings: z.array(searchWarningSchema),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler(
      "search_files",
      async ({ dir_path, pattern, max_depth, max_results }: SearchFilesInput, context: RequestContext) => {
        const pathErr = validatePath(dir_path, "search_files");
        if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_path" });
        // handler 层同源校验：直调路径绕过 SDK zod 层时的第二道（坑清单）
        const inputErr =
          assertStringBounded(pattern, {
            maxChars: SEARCH_BUDGET.patternMaxChars,
            maxBytes: SEARCH_BUDGET.patternMaxBytes,
            param: "pattern",
          }) ??
          assertIntRange(max_depth, { min: 1, max: SEARCH_BUDGET.maxDepth, param: "max_depth" }) ??
          assertIntRange(max_results, { min: 1, max: SEARCH_BUDGET.searchFilesMaxResults, param: "max_results" });
        if (inputErr) return inputErr;
        const t0 = Date.now();
        const maxR = max_results ?? 50;
        const matches: string[] = [];
        const warnings: SearchWarning[] = [];
        let complete = true;

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
                const result = await execFileManaged(esPath, ["-s", "-n", String(maxR * 2), pattern], {
                  maxBuffer: 10 * 1024 * 1024,
                  timeoutMs: 10000,
                  signal: context.signal,
                  requestId: context.requestId,
                  scopeId: context.scopeId,
                  kind: "everything-search",
                });
                for (const line of result.stdout.split("\n")) {
                  const trimmed = line.trim();
                  if (trimmed?.toLowerCase().startsWith(normalizedDir)) {
                    matches.push(trimmed);
                    if (matches.length >= maxR) break;
                  }
                }
              }
            } catch (err) {
              if (context.signal.aborted) return Errors.cancelled("search_files cancelled");
              // CLI failure 可观测：记 warning 后走 native fallback（产品承诺保留）
              logger.warn("search_files", "everything-exec-failed", String(err));
              pushWarning(warnings, { code: WARNING_CODES.EVERYTHING_EXEC_FAILED });
            }
          }

          if (!IS_WIN) {
            // 可选 fd 引擎加速：隐式不可用 → 原生兜底；显式配置错误 → fail-closed（对标 Everything 语义）
            const resolution = await resolveFd();
            if (!resolution.available) {
              if (resolution.source === "explicit") return fdResolutionFailure(resolution);
              logger.debug("search_files", "fd-skipped", resolution.diagnostic.reason);
            } else {
              try {
                const result = await execFileManaged(resolution.path, buildFdArgs(pattern, dir_path, maxR, max_depth), {
                  maxBuffer: 10 * 1024 * 1024,
                  timeoutMs: 10000,
                  signal: context.signal,
                  requestId: context.requestId,
                  scopeId: context.scopeId,
                  kind: "fd-search",
                });
                for (const line of result.stdout.split("\n")) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  matches.push(trimmed);
                  if (matches.length >= maxR) break;
                }
                // fd 遍历错误写 stderr、退出码仍为 0：按非空行计数回传 partial 契约
                const errLines = (result.stderr ?? "").split("\n").filter((l) => l.trim()).length;
                if (errLines > 0) {
                  complete = false;
                  pushWarning(warnings, { code: WARNING_CODES.FD_PARTIAL_ERRORS, count: errLines });
                }
              } catch (err) {
                if (context.signal.aborted) return Errors.cancelled("search_files cancelled");
                // 引擎失败可观测：记 warning 后走 native fallback（产品承诺保留，同 Everything 路径）
                logger.warn("search_files", "fd-exec-failed", String(err));
                pushWarning(warnings, { code: WARNING_CODES.FD_EXEC_FAILED });
              }
            }
          }

          if (matches.length === 0) {
            const outcome = await nativeSearchFiles(dir_path, globToRegex(pattern), {
              maxResults: maxR,
              maxDepth: max_depth ?? 5,
              signal: context.signal,
            });
            matches.push(...outcome.matches);
            warnings.push(...outcome.warnings);
            complete = outcome.complete;
          }

          const ms = Date.now() - t0;
          const truncated = matches.length >= maxR;
          logger.info("search_files", "done", `${matches.length} matches in ${ms}ms`);
          const warnLine = warnings.length > 0 ? `\nWarnings: ${warnings.length} (first: ${warnings[0].code})` : "";
          return success(
            `Found ${matches.length} file(s) in ${ms}ms:\n${matches.join("\n")}${warnLine}`,
            { matches, total: matches.length, search_ms: ms, truncated, complete, warnings },
            { truncated, latency_ms: ms },
          );
        } catch (e: unknown) {
          if (context.signal.aborted) return Errors.cancelled("search_files cancelled");
          return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: true });
        }
      },
    ),
  );

  // ====================================================================
  const EverythingSearchInput = z.object({
    query: boundedString(SEARCH_BUDGET.patternMaxChars, SEARCH_BUDGET.patternMaxBytes).describe(
      "Everything search query. Supports: wildcards(*.txt), regex, path:, size:, date: filters",
    ),
    dir_filter: z.string().optional().describe("Optional: limit search to this directory path"),
    max_results: finiteInt(1, SEARCH_BUDGET.everythingMaxResults).optional().describe("Max results, default 100"),
  });
  type EverythingSearchInput = z.infer<typeof EverythingSearchInput>;

  registerManagedTool(
    server,
    "everything_search",
    {
      title: "Everything Search",
      description: "Ultra-fast full-disk file search powered by Everything engine (Windows only).",
      inputSchema: EverythingSearchInput,
      outputSchema: withErrorSchema(
        z.object({
          matches: z.array(z.string()),
          total: z.number(),
          search_ms: z.number(),
          truncated: z.boolean(),
          complete: z.boolean(),
          warnings: z.array(searchWarningSchema),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler(
      "everything_search",
      async ({ query, dir_filter, max_results }: EverythingSearchInput, context: RequestContext) => {
        if (dir_filter) {
          const pathErr = validatePath(dir_filter, "everything_search");
          if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_filter" });
        }
        // handler 层同源校验（直调路径）
        const inputErr =
          assertStringBounded(query, {
            maxChars: SEARCH_BUDGET.patternMaxChars,
            maxBytes: SEARCH_BUDGET.patternMaxBytes,
            param: "query",
          }) ?? assertIntRange(max_results, { min: 1, max: SEARCH_BUDGET.everythingMaxResults, param: "max_results" });
        if (inputErr) return inputErr;
        const t0 = Date.now();
        const maxR = max_results ?? 100;

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

          const args = ["-s", "-n", String(maxR)];
          if (dir_filter) args.push("-path", dir_filter);
          args.push(query);
          const result = await execFileManaged(esPathWin, args, {
            maxBuffer: 10 * 1024 * 1024,
            timeoutMs: 15000,
            signal: context.signal,
            requestId: context.requestId,
            scopeId: context.scopeId,
            kind: "everything-search",
          });
          results.push(
            ...result.stdout
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line),
          );

          const ms = Date.now() - t0;
          return success(`[Everything ${ms}ms] Found ${results.length} file(s):\n${results.join("\n")}`, {
            matches: results,
            total: results.length,
            search_ms: ms,
            truncated: results.length >= maxR,
            complete: true,
            warnings: [],
          });
        } catch (e: unknown) {
          if (context.signal.aborted) return Errors.cancelled("everything_search cancelled");
          // CLI failure 分类：timeout / 输出截断 / 非零退出分别映射，detail 仅有限元（不携带 stdout/stderr 全文）
          if (e instanceof ManagedProcessError) {
            if (e.timedOut) {
              return fail(ErrorCode.TIMEOUT, "Everything CLI timed out", {
                retryable: true,
                suggestion: "narrow the query or retry",
              });
            }
            if (/maxBuffer|ENOBUFS|ERR_OUT_OF_RANGE/i.test(e.message)) {
              return fail(ErrorCode.RESOURCE_LIMIT, "Everything CLI output exceeded buffer", {
                retryable: true,
                suggestion: "lower max_results",
              });
            }
            return fail(ErrorCode.EXECUTION_FAILED, "Everything CLI failed", {
              retryable: true,
              detail: { exitCode: e.exitCode, signal: e.signal },
            });
          }
          return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: true });
        }
      },
    ),
  );

  // ====================================================================
  const GrepContentInput = z.object({
    dir_path: z.string().describe("Directory to search in"),
    pattern: boundedString(SEARCH_BUDGET.patternMaxChars, SEARCH_BUDGET.patternMaxBytes).describe(
      "Regex pattern to search for in file contents",
    ),
    file_pattern: boundedString(SEARCH_BUDGET.filePatternMaxChars, 1024)
      .optional()
      .describe("File name filter, e.g. *.ts, default *"),
    max_results: finiteInt(1, SEARCH_BUDGET.grepMaxResults).optional().describe("Max matching lines, default 50"),
  });
  type GrepContentInput = z.infer<typeof GrepContentInput>;

  registerManagedTool(
    server,
    "grep_content",
    {
      title: "Grep Content",
      description: "Search file contents using regex pattern. Uses PowerShell Select-String on Windows, grep on Unix.",
      inputSchema: GrepContentInput,
      outputSchema: withErrorSchema(
        z.object({
          matches: z.array(z.string()),
          total: z.number(),
          search_ms: z.number(),
          truncated: z.boolean(),
          complete: z.boolean(),
          warnings: z.array(searchWarningSchema),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler(
      "grep_content",
      async ({ dir_path, pattern, file_pattern, max_results }: GrepContentInput, context: RequestContext) => {
        const pathErr = validatePath(dir_path, "grep_content");
        if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_path" });
        // handler 层同源校验（直调路径）
        const inputErr =
          assertStringBounded(pattern, {
            maxChars: SEARCH_BUDGET.patternMaxChars,
            maxBytes: SEARCH_BUDGET.patternMaxBytes,
            param: "pattern",
          }) ??
          assertStringBounded(file_pattern, {
            maxChars: SEARCH_BUDGET.filePatternMaxChars,
            maxBytes: 1024,
            param: "file_pattern",
          }) ??
          assertIntRange(max_results, { min: 1, max: SEARCH_BUDGET.grepMaxResults, param: "max_results" });
        if (inputErr) return inputErr;
        // 主路径预检 pattern：语法 + ReDoS 防护（与 fallback 路径统一）
        try {
          getRegex(pattern, "gi");
        } catch (e: unknown) {
          return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: false, param: "pattern" });
        }
        const t0 = Date.now();
        const maxR = max_results ?? 50;
        const fileFilter = file_pattern ?? "*";
        const results: string[] = [];
        const warnings: SearchWarning[] = [];
        let complete = true;

        try {
          // PS 入口仅在解析到 PowerShell flavor 时启用；cmd 模式或解析失败走原生降级
          const shellSpec = await getShellSpec().catch(() => null);
          if (IS_WIN && shellSpec && (shellSpec.flavor === "pwsh" || shellSpec.flavor === "powershell")) {
            // 参数内联进单引号字面量（'' 转义），避免拼接注入；
            // 遍历与匹配两段均挂 -ErrorVariable 收集非终止错误，末尾按合计计数写 stderr 标记
            const q = (s: string) => `'${escapePsString(s)}'`;
            const psScript = [
              "$ErrorActionPreference = 'SilentlyContinue';",
              `Get-ChildItem -LiteralPath ${q(dir_path)} -Filter ${q(fileFilter)} -Recurse -File -ErrorVariable +walkErrs |`,
              `  Select-String -Pattern ${q(pattern)} -ErrorVariable +grepErrs |`,
              `  Select-Object -First ${maxR} |`,
              '  ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" };',
              "  $partialErrs = $walkErrs.Count + $grepErrs.Count;",
              '  if ($partialErrs -gt 0) { [Console]::Error.WriteLine("ETMCP_PARTIAL_ERRORS=$partialErrs") }',
            ].join(" ");
            try {
              const inv = buildShellInvocation(psScript, shellSpec);
              const { stdout, stderr } = await execFileManaged(inv.file, inv.args, {
                timeoutMs: 30000,
                maxBuffer: 10 * 1024 * 1024,
                windowsVerbatimArguments: inv.windowsVerbatimArguments,
                signal: context.signal,
                requestId: context.requestId,
                scopeId: context.scopeId,
                kind: "grep",
              });
              results.push(
                ...stdout
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l),
              );
              // PS 遍历/匹配部分错误经 stderr 计数标记回传（明细不回传）
              const partialMatch = /ETMCP_PARTIAL_ERRORS=(\d+)/.exec(stderr ?? "");
              if (partialMatch) {
                const count = Number(partialMatch[1]);
                if (count > 0) {
                  complete = false;
                  pushWarning(warnings, { code: WARNING_CODES.PS_PARTIAL_WALK_ERRORS, count });
                }
              } else if (stderr?.trim()) {
                logger.debug("grep_content", "ps-stderr", stderr.trim());
              }
            } catch (e: unknown) {
              if (context.signal.aborted) return Errors.cancelled("grep_content cancelled");
              logger.warn("grep_content", "ps-error", String(e));
              return fail(ErrorCode.EXECUTION_FAILED, `PowerShell grep failed: ${errMsg(e)}`, {
                retryable: true,
                detail: { dir_path, file_pattern: fileFilter, pattern },
              });
            }
          }

          if (!IS_WIN && results.length === 0) {
            try {
              const grepArgs = ["-rnI", `--include=${fileFilter}`, pattern, dir_path];
              const { stdout } = await execFileManaged("grep", grepArgs, {
                timeoutMs: 30000,
                maxBuffer: 10 * 1024 * 1024,
                signal: context.signal,
                requestId: context.requestId,
                scopeId: context.scopeId,
                kind: "grep",
              });
              results.push(
                ...stdout
                  .split("\n")
                  .map((l) => l.trim())
                  .filter((l) => l)
                  .slice(0, maxR),
              );
            } catch (e: unknown) {
              if (context.signal.aborted) return Errors.cancelled("grep_content cancelled");
              const rawOut = e instanceof ManagedProcessError ? e.stdout : (e as { stdout?: unknown }).stdout;
              const stdout =
                typeof rawOut === "string"
                  ? rawOut
                  : rawOut != null && typeof (rawOut as { toString?: () => string }).toString === "function"
                    ? String((rawOut as { toString: () => string }).toString())
                    : "";
              const code = e instanceof ManagedProcessError ? e.exitCode : (e as { code?: unknown }).code;
              if (code === 1 && !stdout) {
                logger.debug("grep_content", "grep-no-matches", `${dir_path} ${pattern}`);
              } else if (stdout) {
                // 非零退出 + 有输出：遍历部分文件不可读等 partial 场景，不再静默当完整结果
                results.push(
                  ...stdout
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l)
                    .slice(0, maxR),
                );
                complete = false;
                pushWarning(warnings, { code: WARNING_CODES.GREP_PARTIAL_RESULTS });
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
            const outcome = await nativeGrepContent(dir_path, globToRegex(fileFilter), regex, {
              maxResults: maxR,
              signal: context.signal,
            });
            results.push(...outcome.matches);
            warnings.push(...outcome.warnings);
            complete = complete && outcome.complete;
          }

          const ms = Date.now() - t0;
          const truncated = results.length >= maxR;
          logger.info("grep_content", "done", `${results.length} matches in ${ms}ms`);
          const warnLine = warnings.length > 0 ? `\nWarnings: ${warnings.length} (first: ${warnings[0].code})` : "";
          return success(`Found ${results.length} match(es) in ${ms}ms:\n${results.join("\n")}${warnLine}`, {
            matches: results,
            total: results.length,
            search_ms: ms,
            truncated,
            complete,
            warnings,
          });
        } catch (e: unknown) {
          if (context.signal.aborted) return Errors.cancelled("grep_content cancelled");
          return fail(ErrorCode.EXECUTION_FAILED, errMsg(e), { retryable: true });
        }
      },
    ),
  );
}
