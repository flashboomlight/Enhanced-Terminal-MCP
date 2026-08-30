/**
 * 文件操作工具: read_file, write_file, list_directory, file_info, make_directory
 */

import { createReadStream, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { audit } from "../audit.js";
import { toolCache } from "../cache.js";
import { finiteInt } from "../hardening-contract.js";
import { logger } from "../logger.js";
import {
  assertIntRange,
  pushWarning,
  SEARCH_BUDGET,
  type SearchWarning,
  searchWarningSchema,
  WARNING_CODES,
} from "../partial-result.js";
import { atomicWriteFile, resolveForRead, resolveForWrite } from "../path-policy.js";
import { ErrorCode, Errors, fail, success, withErrorSchema } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { scanContent, shouldBlockSecretReads, shouldScanOnWrite } from "../scan.js";
import { registerManagedTool } from "../tool-registry.js";
import { formatSize } from "../utils.js";
import { wrapHandler } from "../wrap.js";

/** 扫描上限常量已移至 scan.ts（SCAN_CONTENT_MAX_BYTES）；write_file 内容上限 */
const WRITE_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** 统一处理 fs 错误：ENOENT -> PATH_NOT_FOUND，其余 -> EXECUTION_FAILED */
function mapFsError(e: unknown, path: string, param: string) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;
  if (code === "ENOENT") {
    return fail(ErrorCode.PATH_NOT_FOUND, `File not found: ${path}`, { retryable: true, param });
  }
  return Errors.executionFailed(msg);
}

export function registerFileTools(server: McpServer) {
  // ====================================================================
  const ReadFileInput = z.object({
    file_path: z.string().describe("Absolute path to the file"),
    encoding: z.string().optional().describe("Encoding, default utf-8"),
    offset: z.number().optional().describe("Start line number (1-indexed), default 1"),
    lines: z.number().optional().describe("Max lines to read, 0 = all"),
  });
  type ReadFileInput = z.infer<typeof ReadFileInput>;

  registerManagedTool(
    server,
    "read_file",
    {
      title: "Read File",
      description: "Read the contents of a file. Supports paging via offset/lines.",
      inputSchema: ReadFileInput,
      outputSchema: withErrorSchema(
        z.object({
          content: z.string(),
          total_lines: z.number(),
          truncated: z.boolean(),
          size_bytes: z.number(),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("read_file", async ({ file_path, encoding, offset, lines }: ReadFileInput) => {
      const resolved = await resolveForRead(file_path, "read_file", "file_path");
      if (!resolved.ok) return resolved.result;
      const target = resolved.resolution.real;

      const VALID_ENCODINGS = new Set([
        "utf-8",
        "utf8",
        "ascii",
        "latin1",
        "binary",
        "hex",
        "base64",
        "ucs2",
        "ucs-2",
        "utf16le",
        "utf-16le",
      ]);
      const enc = (encoding || "utf-8").toLowerCase();
      if (!VALID_ENCODINGS.has(enc)) {
        return fail(ErrorCode.VALIDATION_ERROR, `Unsupported encoding: ${encoding}`, {
          retryable: true,
          param: "encoding",
          suggestion: "Use utf-8, ascii, latin1, or utf16le",
        });
      }

      try {
        const stat = await fs.stat(target);
        const startLine = Math.max(1, offset || 1);
        const maxLines = lines && lines > 0 ? lines : Infinity;

        const collected: string[] = [];
        let lineNum = 0;
        let reachedEnd = true;
        const rl = readline.createInterface({
          input: createReadStream(target, { encoding: enc as BufferEncoding }),
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          lineNum++;
          if (lineNum >= startLine) {
            if (collected.length < maxLines) {
              collected.push(line);
            } else {
              reachedEnd = false;
              rl.close();
              break;
            }
          }
        }

        const truncated = !reachedEnd;
        const output = collected.join("\n");

        // MCP_SECRETS_SCAN=strict：读路径发现密钥拒绝返回正文；扫描不完整（超 4MiB 前缀）同样 fail-closed
        if (shouldBlockSecretReads()) {
          const scan = scanContent(output);
          if (!scan.safe) {
            return fail(
              ErrorCode.PATH_SENSITIVE,
              `Read blocked — content contains secrets: ${scan.findings.join(", ")}`,
              {
                retryable: false,
                param: "file_path",
                suggestion: "Unset MCP_SECRETS_SCAN=strict to allow reading, or remove credentials from file",
                detail: { findings: scan.findings },
              },
            );
          }
          if (!scan.complete) {
            return fail(
              ErrorCode.RESOURCE_LIMIT,
              `Read blocked — content exceeds scanner capacity (scanned ${scan.scannedBytes} bytes) under MCP_SECRETS_SCAN=strict`,
              {
                retryable: false,
                param: "file_path",
                suggestion: "Reduce content size, or relax MCP_SECRETS_SCAN to allow unscannable reads",
              },
            );
          }
        }

        return success(
          truncated ? `${output}\n... (truncated)` : output,
          { content: output, total_lines: lineNum, truncated, size_bytes: stat.size },
          { truncated },
        );
      } catch (e: unknown) {
        return mapFsError(e, file_path, "file_path");
      }
    }),
  );

  // ====================================================================
  const WriteFileInput = z.object({
    file_path: z.string().describe("Absolute path to the file"),
    content: z.string().max(WRITE_FILE_MAX_BYTES, "Content exceeds max write size").describe("Content to write"),
    append: z.boolean().optional().describe("Append instead of overwrite, default false"),
  });
  type WriteFileInput = z.infer<typeof WriteFileInput>;

  registerManagedTool(
    server,
    "write_file",
    {
      title: "Write File",
      description: "Write content to a file (creates parent dirs if needed).",
      inputSchema: WriteFileInput,
      outputSchema: withErrorSchema(
        z.object({
          path: z.string(),
          size_bytes: z.number(),
          existed: z.boolean(),
          appended: z.boolean(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("write_file", async ({ file_path, content, append }: WriteFileInput) => {
      // no-follow 解析：目标/父链 symlink→敏感或系统目录拒绝，目标 symlink 直接拒绝
      const resolved = await resolveForWrite(file_path, "write_file", "file_path");
      if (!resolved.ok) return resolved.result;
      const target = resolved.resolution.real;
      const existed = resolved.resolution.existed;

      // 内容安全扫描（off 跳过；超 4MiB 只扫前缀，strict 下不完整即 fail-closed）
      if (shouldScanOnWrite()) {
        const scan = scanContent(content);
        if (!scan.safe) {
          return fail(ErrorCode.PATH_SENSITIVE, `Content contains secrets: ${scan.findings.join(", ")}`, {
            retryable: false,
            param: "content",
            suggestion: "Remove credentials before writing, or set MCP_SECRETS_SCAN=off",
            detail: { findings: scan.findings },
          });
        }
        if (!scan.complete && shouldBlockSecretReads()) {
          return fail(
            ErrorCode.RESOURCE_LIMIT,
            `Write blocked — content exceeds scanner capacity (scanned ${scan.scannedBytes} bytes) under MCP_SECRETS_SCAN=strict`,
            {
              retryable: false,
              param: "content",
              suggestion: "Reduce content size, or relax MCP_SECRETS_SCAN to allow unscannable writes",
            },
          );
        }
      }

      if (existed && !append) {
        const block = await guardDestructiveAction("write_file", `覆写文件: ${file_path}`);
        if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "file_path" });
      }

      try {
        await fs.mkdir(path.dirname(target), { recursive: true });

        if (append) {
          await fs.appendFile(target, content, "utf-8");
        } else {
          // 原子写：同目录 exclusive staging + rename 替换（不跟随目标 symlink）
          await atomicWriteFile(target, content, "utf-8");
        }

        const stat = await fs.stat(target);
        // 失效该文件及其父目录的缓存条目
        toolCache.invalidateByValue(file_path);
        toolCache.invalidateByValue(path.dirname(file_path));
        logger.info("write_file", "written", file_path);
        audit.record({
          action: "file.write",
          tool: "write_file",
          detail: { path: file_path, size_bytes: stat.size, existed, append: !!append },
          success: true,
        });
        return success(`Written: ${file_path} (${formatSize(stat.size)})`, {
          path: file_path,
          size_bytes: stat.size,
          existed,
          appended: !!append,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.record({
          action: "file.write",
          tool: "write_file",
          detail: { path: file_path, existed },
          success: false,
          error: msg,
        });
        return Errors.executionFailed(msg);
      }
    }),
  );

  // ====================================================================
  const ListDirectoryInput = z.object({
    dir_path: z.string().describe("Absolute path to directory"),
    recursive: z.boolean().optional().describe("List recursively, default false"),
    max_depth: finiteInt(1, SEARCH_BUDGET.maxDepth).optional().describe("Max depth for recursive, default 3"),
  });
  type ListDirectoryInput = z.infer<typeof ListDirectoryInput>;

  registerManagedTool(
    server,
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path with details.",
      inputSchema: ListDirectoryInput,
      outputSchema: withErrorSchema(
        z.object({
          entries: z.array(
            z.object({ name: z.string(), type: z.enum(["file", "dir"]), size_bytes: z.number().optional() }),
          ),
          total: z.number(),
          truncated: z.boolean(),
          complete: z.boolean(),
          warnings: z.array(searchWarningSchema),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("list_directory", async ({ dir_path, recursive, max_depth }: ListDirectoryInput) => {
      const resolved = await resolveForRead(dir_path, "list_directory", "dir_path");
      if (!resolved.ok) return resolved.result;
      // handler 层同源校验（直调路径）
      const inputErr = assertIntRange(max_depth, { min: 1, max: SEARCH_BUDGET.maxDepth, param: "max_depth" });
      if (inputErr) return inputErr;

      try {
        const maxD = max_depth ?? 3;
        const maxE = 2000;
        let count = 0;
        let complete = true;
        const lines: string[] = [];
        const structured: Array<{ name: string; type: "file" | "dir"; size_bytes?: number }> = [];
        const warnings: SearchWarning[] = [];
        const visited = new Set<string>(); // 防止符号链接循环

        async function walk(p: string, depth: number) {
          if (count >= maxE) return;
          // 解析真实路径防止符号链接循环
          let realP: string;
          try {
            realP = await fs.realpath(p);
          } catch (err) {
            logger.debug("list_directory", "realpath-failed", String(err));
            realP = p;
          }
          if (visited.has(realP)) return;
          visited.add(realP);
          let entries: Dirent[];
          try {
            entries = await fs.readdir(p, { withFileTypes: true });
          } catch (e) {
            // 顶层（请求目标本身）不可读 → 整体失败；递归子目录不可读 → partial + warning 继续
            if (depth === 0) throw e;
            complete = false;
            pushWarning(warnings, { code: WARNING_CODES.WALK_READ_FAILED, path: p });
            logger.warn("list_directory", "walk-error", `${p}: ${String(e)}`);
            return;
          }
          const indent = "  ".repeat(depth);
          const files: Array<{ e: (typeof entries)[0]; fp: string }> = [];
          for (const e of entries) {
            if (count >= maxE) {
              lines.push(`${indent}(truncated)`);
              return;
            }
            count++;
            const fp = path.join(p, e.name);
            if (e.isDirectory()) {
              lines.push(`${indent}[DIR]  ${e.name}/`);
              structured.push({ name: fp, type: "dir" });
              if (recursive && depth < maxD) await walk(fp, depth + 1);
            } else {
              files.push({ e, fp });
            }
          }
          // 批量并行 stat 文件
          const stats = await Promise.allSettled(files.map((f) => fs.stat(f.fp)));
          for (let i = 0; i < files.length; i++) {
            const { e, fp } = files[i];
            const r = stats[i];
            if (r.status === "fulfilled") {
              lines.push(`${indent}[FILE] ${e.name}  (${formatSize(r.value.size)})`);
              structured.push({ name: fp, type: "file", size_bytes: r.value.size });
            } else {
              lines.push(`${indent}[FILE] ${e.name}`);
              structured.push({ name: fp, type: "file" });
            }
          }
        }

        lines.push(`Directory: ${dir_path}\n`);
        await walk(resolved.resolution.real, 0);
        logger.info("list_directory", "listed", dir_path);
        if (warnings.length > 0) lines.push(`Warnings: ${warnings.length} (first: ${warnings[0].code})`);

        return success(
          lines.join("\n"),
          { entries: structured, total: count, truncated: count >= maxE, complete, warnings },
          { truncated: count >= maxE },
        );
      } catch (e: unknown) {
        return mapFsError(e, dir_path, "dir_path");
      }
    }),
  );

  // ====================================================================
  const FileInfoInput = z.object({
    target_path: z.string().describe("Absolute path to file or directory"),
  });
  type FileInfoInput = z.infer<typeof FileInfoInput>;

  const fileInfoTool = registerManagedTool(
    server,
    "file_info",
    {
      title: "File Info",
      description: "Get detailed information about a file or directory.",
      inputSchema: FileInfoInput,
      outputSchema: withErrorSchema(
        z.object({
          path: z.string(),
          size_bytes: z.number(),
          is_dir: z.boolean(),
          is_file: z.boolean(),
          created: z.string(),
          modified: z.string(),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("file_info", async ({ target_path }: FileInfoInput) => {
      const resolved = await resolveForRead(target_path, "file_info", "target_path");
      if (!resolved.ok) return resolved.result;

      try {
        const stat = await fs.stat(resolved.resolution.real);
        return success(
          `${stat.isDirectory() ? "Directory" : "File"}: ${target_path}\nSize: ${formatSize(stat.size)}\nModified: ${stat.mtime.toISOString()}`,
          {
            path: target_path,
            size_bytes: stat.size,
            is_dir: stat.isDirectory(),
            is_file: stat.isFile(),
            created: stat.birthtime.toISOString(),
            modified: stat.mtime.toISOString(),
          },
        );
      } catch (e: unknown) {
        return mapFsError(e, target_path, "target_path");
      }
    }),
  );

  if (process.env.ENHANCED_TERMINAL_DISABLE_FILE_INFO === "1") {
    fileInfoTool.disable();
  }

  // ====================================================================
  const MakeDirectoryInput = z.object({
    dir_path: z.string().describe("Absolute path of directory to create"),
  });
  type MakeDirectoryInput = z.infer<typeof MakeDirectoryInput>;

  registerManagedTool(
    server,
    "make_directory",
    {
      title: "Make Directory",
      description: "Create a directory (including parent directories).",
      inputSchema: MakeDirectoryInput,
      outputSchema: withErrorSchema(z.object({ path: z.string(), created: z.boolean() })),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("make_directory", async ({ dir_path }: MakeDirectoryInput) => {
      const resolved = await resolveForWrite(dir_path, "make_directory", "dir_path");
      if (!resolved.ok) return resolved.result;
      const target = resolved.resolution.real;

      try {
        let existed = false;
        try {
          const s = await fs.stat(target);
          existed = s.isDirectory();
        } catch (err) {
          logger.debug("make_directory", "stat-failed", String(err));
        }
        await fs.mkdir(target, { recursive: true });
        logger.info("make_directory", "created", dir_path);
        return success(`Created: ${dir_path}`, { path: dir_path, created: !existed });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return Errors.executionFailed(msg);
      }
    }),
  );
}
