// src/tools/search.ts — 搜索工具：search_files / everything_search / grep_content
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { ok, fail } from "../utils.js";
import { IS_WIN } from "../platform.js";
import { logger } from "../logger.js";

const execFileAsync = promisify(execFile);

// Everything es.exe 路径（项目自带）
// 注意：decodeURIComponent 解决路径含空格时 %20 编码问题
const __dirname = decodeURIComponent(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"))
);
const ES_EXE = path.join(__dirname, "..", "..", "es_tool", "es.exe");

// Everything.exe 路径（全量版），优先使用环境变量 EVERYTHING_EXE_PATH
const EVERYTHING_EXE = process.env.EVERYTHING_EXE_PATH || "D:\\Everything\\Everything.exe";

// 缓存 Everything 就绪状态，避免每次搜索都轮询
let everythingReady: boolean | null = null;
let everythingCheckTime = 0;
const CACHE_TTL = 60000; // 1 分钟缓存

/**
 * 检测 Everything 进程是否正在运行（Windows only）
 */
async function isEverythingRunning(): Promise<boolean> {
  if (!IS_WIN) return false;
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", "IMAGENAME eq Everything*", "/FO", "CSV", "/NH"],
      { timeout: 5000 }
    );
    return stdout.toLowerCase().includes("everything");
  } catch {
    return false;
  }
}

/**
 * 启动 Everything 并等待其 IPC 服务就绪
 */
async function ensureEverythingReady(): Promise<boolean> {
  // 非 Windows 直接返回 false
  if (!IS_WIN) return false;

  // 使用缓存避免频繁轮询
  if (everythingReady !== null && Date.now() - everythingCheckTime < CACHE_TTL) {
    return everythingReady;
  }

  // 1. 检查 es.exe 是否存在
  if (!fs.existsSync(ES_EXE)) {
    everythingReady = false;
    everythingCheckTime = Date.now();
    return false;
  }

  // 2. 快速测试：es.exe 能否直接查询（Everything 已在运行）
  try {
    await execFileAsync(ES_EXE, ["-max-results", "1", "readme"], { timeout: 3000 });
    everythingReady = true;
    everythingCheckTime = Date.now();
    return true;
  } catch {
    // es.exe 查询失败，说明 Everything 可能没运行
  }

  // 3. 检查 Everything.exe 是否存在
  if (!fs.existsSync(EVERYTHING_EXE)) {
    everythingReady = false;
    everythingCheckTime = Date.now();
    return false;
  }

  // 4. 检查进程是否已在运行
  const alreadyRunning = await isEverythingRunning();

  // 5. 如果没在运行，启动它
  if (!alreadyRunning) {
    try {
      const child = spawn(EVERYTHING_EXE, ["-startup"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
    } catch {
      everythingReady = false;
      everythingCheckTime = Date.now();
      return false;
    }
  }

  // 6. 轮询等待就绪（最多 15 秒）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      await execFileAsync(ES_EXE, ["-max-results", "1", "readme"], { timeout: 3000 });
      everythingReady = true;
      everythingCheckTime = Date.now();
      return true;
    } catch {
      // 还没就绪，继续等
    }
  }

  everythingReady = false;
  everythingCheckTime = Date.now();
  return false;
}

/**
 * 使用 Everything es.exe 进行闪电搜索
 */
async function everythingSearch(
  pattern: string,
  dirPath?: string,
  maxResults: number = 50
): Promise<string[]> {
  const args: string[] = [];
  args.push("-max-results", String(maxResults));

  if (dirPath) {
    const normalizedDir = dirPath.replace(/\//g, "\\").replace(/\\$/, "");
    args.push("-path", normalizedDir);
  }

  args.push(pattern);

  const { stdout } = await execFileAsync(ES_EXE, args, {
    timeout: 10000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 原生递归搜索（兜底方案，全平台可用）
 */
function nativeSearch(
  dirPath: string,
  regex: RegExp,
  maxDepth: number,
  maxResults: number
): string[] {
  const results: string[] = [];

  function walk(p: string, depth: number) {
    if (depth > maxDepth || results.length >= maxResults) return;
    try {
      const entries = fs.readdirSync(p, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        const full = path.join(p, entry.name);
        if (entry.isFile() && regex.test(entry.name)) {
          results.push(full);
        }
        if (
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name !== "node_modules" &&
          entry.name !== "$Recycle.Bin" &&
          entry.name !== "System Volume Information"
        ) {
          walk(full, depth + 1);
        }
      }
    } catch {
      /* skip inaccessible dirs */
    }
  }

  walk(dirPath, 0);
  return results;
}

export function registerSearchTools(server: McpServer) {
  // ===== Tool 9: search_files =====
  server.registerTool(
    "search_files",
    {
      title: "Search Files",
      description: "Search for files by name pattern. Auto-starts Everything engine for instant results, falls back to native search if unavailable.",
      inputSchema: {
        dir_path: z.string().describe("Directory to search in"),
        pattern: z.string().describe("Filename pattern, e.g. *.ts, *.log, test*"),
        max_depth: z.number().optional().describe("Max search depth for native fallback, default 5"),
        max_results: z.number().optional().describe("Max results, default 50"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ dir_path, pattern, max_depth, max_results }) => {
      try {
        const maxR = max_results || 50;
        const startTime = Date.now();

        // 优先尝试 Everything（Windows only）
        const evReady = await ensureEverythingReady();

        if (evReady) {
          const results = await everythingSearch(pattern, dir_path, maxR);
          const elapsed = Date.now() - startTime;

          if (results.length === 0) {
            return ok(`[Everything ${elapsed}ms] No files found matching: ${pattern}`);
          }
          logger.info("search_files", "everything", `${results.length} results in ${elapsed}ms`);
          return ok(
            `[Everything ${elapsed}ms] Found ${results.length} file(s):\n` +
              results.join("\n")
          );
        }

        // 兜底：原生搜索（全平台可用）
        const maxD = max_depth || 5;
        const regexStr =
          "^" +
          pattern
            .replace(/\./g, "\\.")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$";
        const regex = new RegExp(regexStr, "i");

        const results = nativeSearch(dir_path, regex, maxD, maxR);
        const elapsed = Date.now() - startTime;

        if (results.length === 0) {
          return ok(`[Native ${elapsed}ms] No files found matching: ${pattern}`);
        }
        return ok(
          `[Native ${elapsed}ms] Found ${results.length} file(s):\n` +
            results.join("\n")
        );
      } catch (e: any) {
        return fail("Search failed: " + e.message);
      }
    }
  );

  // ===== Tool: everything_search =====
  server.registerTool(
    "everything_search",
    {
      title: "Everything Search",
      description: "Ultra-fast full-disk file search powered by Everything engine. Auto-detects and auto-starts Everything if not running. Supports Everything advanced syntax.",
      inputSchema: {
        query: z.string().describe("Everything search query. Supports: wildcards(*.txt), regex, path: size: date: filters"),
        dir_filter: z.string().optional().describe("Optional: limit search to this directory path"),
        max_results: z.number().optional().describe("Max results, default 100"),
        match_case: z.boolean().optional().describe("Case sensitive search, default false"),
        match_whole_word: z.boolean().optional().describe("Match whole word only, default false"),
        match_regex: z.boolean().optional().describe("Use regex mode, default false"),
        sort_by: z.enum(["name", "path", "size", "date_modified"]).optional().describe("Sort results by field"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ query, dir_filter, max_results, match_case, match_whole_word, match_regex, sort_by }) => {
      try {
        const evReady = await ensureEverythingReady();
        if (!evReady) {
          return fail(
            "Everything not available!\n\n" +
            (IS_WIN
              ? "Possible reasons:\n" +
                "1. Everything.exe not found at: " + EVERYTHING_EXE + "\n" +
                "2. es.exe not found at: " + ES_EXE + "\n" +
                "3. Everything failed to initialize within 15 seconds\n\n" +
                "Manual fix: Start Everything manually, then retry."
              : "Everything search is only available on Windows.\n" +
                "Use search_files for cross-platform file search.")
          );
        }

        const maxR = max_results || 100;
        const startTime = Date.now();

        const args: string[] = [];
        args.push("-max-results", String(maxR));

        if (match_case) args.push("-case");
        if (match_whole_word) args.push("-whole-word");
        if (match_regex) args.push("-regex");

        if (sort_by) {
          const sortMap: Record<string, string> = {
            name: "name",
            path: "path",
            size: "size",
            date_modified: "date-modified",
          };
          args.push("-sort", sortMap[sort_by] || "name");
        }

        if (dir_filter) {
          const normalizedDir = dir_filter.replace(/\//g, "\\").replace(/\\$/, "");
          args.push("-path", normalizedDir);
        }
        args.push(query);

        const { stdout } = await execFileAsync(ES_EXE, args, {
          timeout: 15000,
          maxBuffer: 10 * 1024 * 1024,
        });

        const results = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length > 0);

        const elapsed = Date.now() - startTime;

        if (results.length === 0) {
          return ok(`[Everything ${elapsed}ms] No results for: ${query}`);
        }

        logger.info("everything_search", "search", `${results.length} results in ${elapsed}ms`);
        return ok(
          `[Everything ${elapsed}ms] Found ${results.length} result(s):\n` +
            results.join("\n")
        );
      } catch (e: any) {
        return fail("Everything search failed: " + e.message);
      }
    }
  );

  // ===== Tool 10: grep_content =====
  server.registerTool(
    "grep_content",
    {
      title: "Grep Content",
      description: "Search file contents using regex pattern (like grep). Uses PowerShell Select-String on Windows for better performance.",
      inputSchema: {
        dir_path: z.string().describe("Directory to search in"),
        pattern: z.string().describe("Regex pattern to search for in file contents"),
        file_pattern: z.string().optional().describe("File name filter, e.g. *.ts, default *"),
        max_results: z.number().optional().describe("Max matching lines, default 50"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ dir_path, pattern, file_pattern, max_results }) => {
      try {
        const maxR = max_results || 50;
        const startTime = Date.now();
        const fileFilter = file_pattern || "*";

        // Windows: 优先使用 PowerShell Select-String
        if (IS_WIN) {
          try {
            const psCmd = `Get-ChildItem -Path '${dir_path}' -Filter '${fileFilter}' -Recurse -File -ErrorAction SilentlyContinue | Select-String -Pattern '${pattern.replace(/'/g, "''")}' -List | Select-Object -First ${maxR} | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line.Trim())" }`;

            const { stdout } = await execFileAsync(
              "powershell",
              ["-NoProfile", "-Command", psCmd],
              { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
            );

            const results = stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);

            const elapsed = Date.now() - startTime;

            if (results.length === 0) {
              return ok(`[PowerShell ${elapsed}ms] No matches found for: ${pattern}`);
            }
            logger.info("grep_content", "powershell", `${results.length} matches in ${elapsed}ms`);
            return ok(
              `[PowerShell ${elapsed}ms] Found ${results.length} match(es):\n` +
                results.join("\n")
            );
          } catch {
            // PowerShell 失败，回退到原生方案
          }
        }

        // Linux/macOS: 尝试使用系统 grep
        if (!IS_WIN) {
          try {
            const grepCmd = fileFilter === "*"
              ? `grep -rn "${pattern}" "${dir_path}" --include="*" -m ${maxR} 2>/dev/null`
              : `grep -rn "${pattern}" "${dir_path}" --include="${fileFilter}" -m ${maxR} 2>/dev/null`;

            const { stdout } = await execFileAsync(
              "/bin/sh",
              ["-c", grepCmd],
              { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
            );

            const results = stdout
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 0);

            const elapsed = Date.now() - startTime;

            if (results.length === 0) {
              return ok(`[grep ${elapsed}ms] No matches found for: ${pattern}`);
            }
            return ok(
              `[grep ${elapsed}ms] Found ${results.length} match(es):\n` +
                results.join("\n")
            );
          } catch {
            // 系统 grep 失败，回退到原生方案
          }
        }

        // 兜底：原生 Node.js 搜索（全平台）
        const regex = new RegExp(pattern, "gi");
        const results: string[] = [];

        const fileRegexStr =
          "^" +
          fileFilter
            .replace(/\./g, "\\.")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$";
        const fileRegex = new RegExp(fileRegexStr, "i");

        function searchDir(p: string, depth: number) {
          if (depth > 5 || results.length >= maxR) return;
          try {
            const entries = fs.readdirSync(p, { withFileTypes: true });
            for (const entry of entries) {
              if (results.length >= maxR) break;
              const full = path.join(p, entry.name);
              if (entry.isFile() && fileRegex.test(entry.name)) {
                try {
                  const content = fs.readFileSync(full, "utf-8");
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (results.length >= maxR) break;
                    if (regex.test(lines[i])) {
                      results.push(full + ":" + (i + 1) + ": " + lines[i].trim());
                    }
                  }
                } catch {
                  /* skip binary/unreadable */
                }
              }
              if (
                entry.isDirectory() &&
                !entry.name.startsWith(".") &&
                entry.name !== "node_modules"
              ) {
                searchDir(full, depth + 1);
              }
            }
          } catch {
            /* skip */
          }
        }

        searchDir(dir_path, 0);
        const elapsed = Date.now() - startTime;

        if (results.length === 0) {
          return ok(`[Native ${elapsed}ms] No matches found for: ${pattern}`);
        }
        return ok(
          `[Native ${elapsed}ms] Found ${results.length} match(es):\n` +
            results.join("\n")
        );
      } catch (e: any) {
        return fail("Grep failed: " + e.message);
      }
    }
  );
}
