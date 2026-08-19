/**
 * 文件操作工具: read_file, write_file, list_directory, file_info, make_directory
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { toolCache } from "../cache.js";
import { logger } from "../logger.js";
import { ErrorCode, fail, success } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { scanContent } from "../scan.js";
import { validatePath } from "../security.js";
import { formatSize } from "../utils.js";
import { wrapHandler } from "../wrap.js";

export function registerFileTools(server: McpServer) {
  // ====================================================================
  const ReadFileInput = z.object({
    file_path: z.string().describe("Absolute path to the file"),
    encoding: z.string().optional().describe("Encoding, default utf-8"),
    offset: z.number().optional().describe("Start line number (1-indexed), default 1"),
    lines: z.number().optional().describe("Max lines to read, 0 = all"),
  });
  type ReadFileInput = z.infer<typeof ReadFileInput>;

  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: "Read the contents of a file. Supports paging via offset/limit.",
      inputSchema: ReadFileInput,
      outputSchema: z.object({
        content: z.string(),
        total_lines: z.number(),
        truncated: z.boolean(),
        size_bytes: z.number(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("read_file", async ({ file_path, encoding, offset, lines }: ReadFileInput) => {
      const pathErr = validatePath(file_path, "read_file");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "file_path" });

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
        const stat = await fs.stat(file_path);
        const startLine = Math.max(1, offset || 1);
        const maxLines = lines && lines > 0 ? lines : Infinity;

        const collected: string[] = [];
        let lineNum = 0;
        let reachedEnd = true;
        const rl = readline.createInterface({
          input: createReadStream(file_path, { encoding: enc as BufferEncoding }),
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

        return success(
          truncated ? `${output}\n... (truncated)` : output,
          { content: output, total_lines: lineNum, truncated, size_bytes: stat.size },
          { truncated },
        );
      } catch (e: any) {
        if (e.code === "ENOENT")
          return fail(ErrorCode.PATH_NOT_FOUND, `File not found: ${file_path}`, {
            retryable: true,
            param: "file_path",
          });
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const WriteFileInput = z.object({
    file_path: z.string().describe("Absolute path to the file"),
    content: z.string().describe("Content to write"),
    append: z.boolean().optional().describe("Append instead of overwrite, default false"),
  });
  type WriteFileInput = z.infer<typeof WriteFileInput>;

  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Write content to a file (creates parent dirs if needed).",
      inputSchema: WriteFileInput,
      outputSchema: z.object({
        path: z.string(),
        size_bytes: z.number(),
        existed: z.boolean(),
        appended: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("write_file", async ({ file_path, content, append }: WriteFileInput) => {
      const pathErr = validatePath(file_path, "write_file");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "file_path" });

      // 内容安全扫描
      const scan = scanContent(content);
      if (!scan.safe) {
        return fail(ErrorCode.PATH_SENSITIVE, `Content contains secrets: ${scan.findings.join(", ")}`, {
          retryable: false,
          param: "content",
          suggestion: "Remove credentials before writing",
          detail: { findings: scan.findings },
        });
      }

      // 仅覆写已有文件时触发安全确认
      let existed = false;
      try {
        await fs.stat(file_path);
        existed = true;
      } catch {}

      if (existed && !append) {
        const block = await guardDestructiveAction("write_file", `覆写文件: ${file_path}`);
        if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "file_path" });
      }

      try {
        await fs.mkdir(path.dirname(file_path), { recursive: true });

        if (append) {
          await fs.appendFile(file_path, content, "utf-8");
        } else {
          await fs.writeFile(file_path, content, "utf-8");
        }

        const stat = await fs.stat(file_path);
        // 失效该文件及其父目录的缓存条目
        toolCache.invalidateByValue(file_path);
        toolCache.invalidateByValue(path.dirname(file_path));
        logger.info("write_file", "written", file_path);
        return success(`Written: ${file_path} (${formatSize(stat.size)})`, {
          path: file_path,
          size_bytes: stat.size,
          existed,
          appended: !!append,
        });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const ListDirectoryInput = z.object({
    dir_path: z.string().describe("Absolute path to directory"),
    recursive: z.boolean().optional().describe("List recursively, default false"),
    max_depth: z.number().optional().describe("Max depth for recursive, default 3"),
  });
  type ListDirectoryInput = z.infer<typeof ListDirectoryInput>;

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path with details.",
      inputSchema: ListDirectoryInput,
      outputSchema: z.object({
        entries: z.array(
          z.object({ name: z.string(), type: z.enum(["file", "dir"]), size_bytes: z.number().optional() }),
        ),
        total: z.number(),
        truncated: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("list_directory", async ({ dir_path, recursive, max_depth }: ListDirectoryInput) => {
      const pathErr = validatePath(dir_path, "list_directory");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_path" });

      try {
        const maxD = max_depth || 3;
        const maxE = 2000;
        let count = 0;
        const lines: string[] = [];
        const structured: Array<{ name: string; type: "file" | "dir"; size_bytes?: number }> = [];
        const visited = new Set<string>(); // 防止符号链接循环

        async function walk(p: string, depth: number) {
          if (count >= maxE) return;
          // 解析真实路径防止符号链接循环
          let realP: string;
          try {
            realP = await fs.realpath(p);
          } catch {
            realP = p;
          }
          if (visited.has(realP)) return;
          visited.add(realP);
          const entries = await fs.readdir(p, { withFileTypes: true });
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
        await walk(dir_path, 0);
        logger.info("list_directory", "listed", dir_path);

        return success(
          lines.join("\n"),
          { entries: structured, total: count, truncated: count >= maxE },
          { truncated: count >= maxE },
        );
      } catch (e: any) {
        if (e.code === "ENOENT")
          return fail(ErrorCode.PATH_NOT_FOUND, `Directory not found: ${dir_path}`, {
            retryable: true,
            param: "dir_path",
          });
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const FileInfoInput = z.object({
    target_path: z.string().describe("Absolute path to file or directory"),
  });
  type FileInfoInput = z.infer<typeof FileInfoInput>;

  const fileInfoTool = server.registerTool(
    "file_info",
    {
      title: "File Info",
      description: "Get detailed information about a file or directory.",
      inputSchema: FileInfoInput,
      outputSchema: z.object({
        path: z.string(),
        size_bytes: z.number(),
        is_dir: z.boolean(),
        is_file: z.boolean(),
        created: z.string(),
        modified: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("file_info", async ({ target_path }: FileInfoInput) => {
      const pathErr = validatePath(target_path, "file_info");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "target_path" });

      try {
        const stat = await fs.stat(target_path);
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
      } catch (e: any) {
        if (e.code === "ENOENT")
          return fail(ErrorCode.PATH_NOT_FOUND, `Not found: ${target_path}`, { retryable: true, param: "target_path" });
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
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

  server.registerTool(
    "make_directory",
    {
      title: "Make Directory",
      description: "Create a directory (including parent directories).",
      inputSchema: MakeDirectoryInput,
      outputSchema: z.object({ path: z.string(), created: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("make_directory", async ({ dir_path }: MakeDirectoryInput) => {
      const pathErr = validatePath(dir_path, "make_directory");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "dir_path" });

      try {
        let existed = false;
        try {
          const s = await fs.stat(dir_path);
          existed = s.isDirectory();
        } catch {}
        await fs.mkdir(dir_path, { recursive: true });
        logger.info("make_directory", "created", dir_path);
        return success(`Created: ${dir_path}`, { path: dir_path, created: !existed });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );
}
