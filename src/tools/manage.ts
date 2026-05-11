// src/tools/manage.ts — 文件管理工具：copy_move / delete_path
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { formatSize, ok, fail } from "../utils.js";
import { validatePath } from "../security.js";
import { guardDestructiveAction, getSafetyMode } from "../safeguard.js";
import { logger } from "../logger.js";

export function registerManageTools(server: McpServer) {

  // ===== Tool 11: copy_move =====
  server.registerTool(
    "copy_move",
    {
      title: "Copy or Move",
      description: "Copy or move a file/directory to a new location",
      inputSchema: {
        source: z.string().describe("Source path"),
        destination: z.string().describe("Destination path"),
        operation: z.enum(["copy", "move"]).describe("Operation: copy or move"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ source, destination, operation }) => {
      const srcErr = validatePath(source, "copy_move:source");
      if (srcErr) return fail(srcErr);
      const dstErr = validatePath(destination, "copy_move:destination");
      if (dstErr) return fail(dstErr);
      try {
        const destDir = path.dirname(destination);
        await fs.mkdir(destDir, { recursive: true });

        if (operation === "copy") {
          const stat = await fs.stat(source);
          if (stat.isDirectory()) {
            await fs.cp(source, destination, { recursive: true });
          } else {
            await fs.copyFile(source, destination);
          }
          logger.info("copy_move", "copied", `${source} -> ${destination}`);
          return ok("Copied: " + source + " -> " + destination);
        } else {
          await fs.rename(source, destination);
          logger.info("copy_move", "moved", `${source} -> ${destination}`);
          return ok("Moved: " + source + " -> " + destination);
        }
      } catch (e: any) {
        logger.error("copy_move", "failed", e.message);
        return fail("Operation failed: " + e.message);
      }
    }
  );

  // ===== Tool 12: delete_path =====
  server.registerTool(
    "delete_path",
    {
      title: "Delete Path",
      description: "Delete a file or directory (use with caution!)",
      inputSchema: {
        target_path: z.string().describe("Path to delete"),
        recursive: z.boolean().optional().describe("Delete directory recursively, default false"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ target_path, recursive }) => {
      // 硬性底线：路径安全检查（所有模式生效）
      const pathErr = validatePath(target_path, "delete_path");
      if (pathErr) return fail(pathErr);

      // strict 模式：所有删除操作直接拒绝（在 stat 之前，避免文件不存在时先报 ENOENT）
      if (getSafetyMode() === "strict") {
        const blocked = await guardDestructiveAction("delete_path", `删除: ${target_path}`);
        if (blocked) return fail(blocked);
      }

      try {
        const stat = await fs.stat(target_path);

        // 安全锁：删除操作需要确认
        let desc: string;
        if (stat.isDirectory()) {
          // 统计目录内容
          try {
            const entries = await fs.readdir(target_path);
            let fileCount = 0;
            let dirCount = 0;
            for (const e of entries) {
              const s = await fs.stat(path.join(target_path, e)).catch(() => null);
              if (s?.isDirectory()) dirCount++;
              else fileCount++;
            }
            desc = `删除目录: ${target_path}\n` +
                   `模式: ${recursive ? "递归删除" : "仅空目录"}\n` +
                   `包含: ${fileCount} 个文件, ${dirCount} 个子目录\n\n` +
                   `删除后无法恢复！`;
          } catch {
            desc = `删除目录: ${target_path}\n模式: ${recursive ? "递归删除" : "仅空目录"}`;
          }
        } else {
          desc = `删除文件: ${target_path}\n大小: ${formatSize(stat.size)}\n\n删除后无法恢复！`;
        }

        const blocked = await guardDestructiveAction("delete_path", desc);
        if (blocked) return fail(blocked);

        // 执行删除
        if (stat.isDirectory()) {
          if (recursive) {
            await fs.rm(target_path, { recursive: true, force: true });
          } else {
            await fs.rmdir(target_path);
          }
          logger.warn("delete_path", "deleted directory", target_path);
          return ok("Directory deleted: " + target_path);
        } else {
          await fs.unlink(target_path);
          logger.warn("delete_path", "deleted file", target_path);
          return ok("File deleted: " + target_path);
        }
      } catch (e: any) {
        return fail("Delete failed: " + e.message);
      }
    }
  );
}
