// src/tools/files.ts — 文件操作工具：read_file / write_file / list_directory / file_info / make_directory
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { formatSize, ok, fail, okStructured } from "../utils.js";
import { validatePath } from "../security.js";
import { guardDestructiveAction } from "../safeguard.js";
import { logger } from "../logger.js";

export function registerFileTools(server: McpServer) {

  // ===== Tool 4: read_file =====
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: "Read the contents of a file",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file"),
        encoding: z.string().optional().describe("Encoding, default utf-8"),
        lines: z.number().optional().describe("Max lines to read, 0 = all"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ file_path, encoding, lines }) => {
      const pathErr = validatePath(file_path, "read_file");
      if (pathErr) return fail(pathErr);
      try {
        const enc = (encoding || "utf-8") as BufferEncoding;
        let content = await fs.readFile(file_path, enc);
        if (lines && lines > 0) {
          content = content.split("\n").slice(0, lines).join("\n");
        }
        logger.info("read_file", "read", file_path);
        return ok(content);
      } catch (e: any) {
        logger.error("read_file", "failed", e.message);
        return fail("Read failed: " + e.message);
      }
    }
  );

  // ===== Tool 5: write_file =====
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Write content to a file (creates parent dirs if needed)",
      inputSchema: {
        file_path: z.string().describe("Absolute path to the file"),
        content: z.string().describe("Content to write"),
        append: z.boolean().optional().describe("Append instead of overwrite, default false"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ file_path, content, append }) => {
      const pathErr = validatePath(file_path, "write_file");
      if (pathErr) return fail(pathErr);

      // 安全锁：覆写已有文件时需要确认（新建和 append 不需要）
      if (!append && fsSync.existsSync(file_path)) {
        try {
          const existingStat = await fs.stat(file_path);
          const blocked = await guardDestructiveAction(
            "write_file",
            `即将覆写已有文件:\n` +
            `路径: ${file_path}\n` +
            `当前大小: ${formatSize(existingStat.size)}\n` +
            `最后修改: ${existingStat.mtime.toISOString()}\n\n` +
            `覆写后原有内容将丢失，无法恢复。`
          );
          if (blocked) return fail(blocked);
        } catch {
          // stat 失败说明文件不存在或不可访问，继续写入
        }
      }

      try {
        const dir = path.dirname(file_path);
        await fs.mkdir(dir, { recursive: true });
        if (append) {
          await fs.appendFile(file_path, content, "utf-8");
          logger.info("write_file", "appended", file_path);
          return ok("Appended to: " + file_path);
        } else {
          await fs.writeFile(file_path, content, "utf-8");
          logger.info("write_file", "written", file_path);
          return ok("Written to: " + file_path);
        }
      } catch (e: any) {
        logger.error("write_file", "failed", e.message);
        return fail("Write failed: " + e.message);
      }
    }
  );

  // ===== Tool 6: list_directory =====
  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path with details",
      inputSchema: {
        dir_path: z.string().describe("Absolute path to directory"),
        recursive: z.boolean().optional().describe("List recursively, default false"),
        max_depth: z.number().optional().describe("Max depth for recursive, default 3"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ dir_path, recursive, max_depth }) => {
      const pathErr = validatePath(dir_path, "list_directory");
      if (pathErr) return fail(pathErr);
      try {
        const maxD = max_depth || 3;
        const lines: string[] = [];
        lines.push("Directory: " + dir_path + "\n");

        async function listDir(p: string, depth: number) {
          const entries = await fs.readdir(p, { withFileTypes: true });
          const indent = "  ".repeat(depth);
          for (const entry of entries) {
            const full = path.join(p, entry.name);
            if (entry.isDirectory()) {
              lines.push(indent + "[DIR]  " + entry.name + "/");
              if (recursive && depth < maxD) {
                await listDir(full, depth + 1);
              }
            } else {
              try {
                const stat = await fs.stat(full);
                lines.push(indent + "[FILE] " + entry.name + "  (" + formatSize(stat.size) + ")");
              } catch {
                lines.push(indent + "[FILE] " + entry.name);
              }
            }
          }
        }

        await listDir(dir_path, 0);
        logger.info("list_directory", "listed", dir_path);
        return ok(lines.join("\n"));
      } catch (e: any) {
        return fail("List failed: " + e.message);
      }
    }
  );

  // ===== Tool 7: file_info =====
  server.registerTool(
    "file_info",
    {
      title: "File Info",
      description: "Get detailed information about a file or directory",
      inputSchema: {
        target_path: z.string().describe("Absolute path to file or directory"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ target_path }) => {
      const pathErr = validatePath(target_path, "file_info");
      if (pathErr) return fail(pathErr);
      try {
        const stat = await fs.stat(target_path);
        const fileType = stat.isDirectory() ? "Directory" : stat.isFile() ? "File" : "Other";
        const data = {
          path: target_path,
          type: fileType,
          size: stat.size,
          sizeFormatted: formatSize(stat.size),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
          permissions: "0" + (stat.mode & 0o777).toString(8),
        };
        const info = [
          "Path: " + data.path,
          "Type: " + data.type,
          "Size: " + data.sizeFormatted,
          "Created: " + data.created,
          "Modified: " + data.modified,
          "Accessed: " + data.accessed,
          "Permissions: " + data.permissions,
        ];
        logger.info("file_info", "info", target_path);
        return okStructured(info.join("\n"), data);
      } catch (e: any) {
        return fail("Info failed: " + e.message);
      }
    }
  );

  // ===== Tool 8: make_directory =====
  server.registerTool(
    "make_directory",
    {
      title: "Make Directory",
      description: "Create a directory (including parent directories)",
      inputSchema: {
        dir_path: z.string().describe("Absolute path of directory to create"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ dir_path }) => {
      const pathErr = validatePath(dir_path, "make_directory");
      if (pathErr) return fail(pathErr);
      try {
        await fs.mkdir(dir_path, { recursive: true });
        logger.info("make_directory", "created", dir_path);
        return ok("Directory created: " + dir_path);
      } catch (e: any) {
        return fail("Mkdir failed: " + e.message);
      }
    }
  );
}
