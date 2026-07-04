/**
 * 文件管理工具: copy_move, delete_path
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { audit } from "../audit.js";
import { toolCache } from "../cache.js";
import { logger } from "../logger.js";
import { ErrorCode, fail, success } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { validatePath } from "../security.js";
import { wrapHandler } from "../wrap.js";

export function registerManageTools(server: McpServer) {
  const CopyMoveInput = z.object({
    source: z.string().describe("Source path"),
    destination: z.string().describe("Destination path"),
    operation: z.enum(["copy", "move"]).describe("Operation: copy or move"),
  });
  type CopyMoveInput = z.infer<typeof CopyMoveInput>;

  server.registerTool(
    "copy_move",
    {
      title: "Copy or Move",
      description: "Copy or move a file/directory to a new location.",
      inputSchema: CopyMoveInput,
      outputSchema: z.object({ source: z.string(), destination: z.string(), operation: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    wrapHandler("copy_move", async ({ source, destination, operation }: CopyMoveInput) => {
      for (const [p, label] of [
        [source, "source"],
        [destination, "destination"],
      ] as const) {
        const err = validatePath(p, `copy_move:${label}`);
        if (err) return fail(ErrorCode.PATH_FORBIDDEN, err, { retryable: false, param: label });
      }

      const block = await guardDestructiveAction("copy_move", `${operation}: ${source} -> ${destination}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "operation" });

      try {
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (operation === "copy") {
          await fs.cp(source, destination, { recursive: true });
        } else {
          await fs.rename(source, destination);
        }
        logger.info("copy_move", `${operation === "copy" ? "copied" : "moved"}`, `${source} -> ${destination}`);
        audit.record({
          action: "file.move",
          tool: "copy_move",
          detail: { source, destination, operation },
          success: true,
        });
        toolCache.invalidateByValue(source);
        toolCache.invalidateByValue(destination);
        return success(`${operation === "copy" ? "Copied" : "Moved"}: ${source} -> ${destination}`, {
          source,
          destination,
          operation,
        });
      } catch (e: any) {
        audit.record({
          action: "file.move",
          tool: "copy_move",
          detail: { source, destination, operation },
          success: false,
          error: e.message,
        });
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  const DeletePathInput = z.object({
    target_path: z.string().describe("Path to delete"),
    recursive: z.boolean().optional().describe("Delete directory recursively, default false"),
  });
  type DeletePathInput = z.infer<typeof DeletePathInput>;

  server.registerTool(
    "delete_path",
    {
      title: "Delete Path",
      description: "Delete a file or directory (use with caution!).",
      inputSchema: DeletePathInput,
      outputSchema: z.object({ path: z.string(), type: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("delete_path", async ({ target_path, recursive }: DeletePathInput) => {
      const pathErr = validatePath(target_path, "delete_path");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "target_path" });

      const block = await guardDestructiveAction("delete_path", `删除: ${target_path}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "target_path" });

      try {
        const stat = await fs.stat(target_path);
        if (stat.isDirectory()) {
          if (!recursive) {
            return fail(
              ErrorCode.VALIDATION_ERROR,
              `Cannot delete non-empty directory without recursive=true: ${target_path}`,
              { retryable: true, param: "recursive", suggestion: "Set recursive=true to delete directory contents" },
            );
          }
          await fs.rm(target_path, { recursive: true, force: true });
        } else {
          await fs.unlink(target_path);
        }
        logger.warn("delete_path", `deleted ${stat.isDirectory() ? "dir" : "file"}`, target_path);
        audit.record({
          action: "file.delete",
          tool: "delete_path",
          detail: { path: target_path, type: stat.isDirectory() ? "dir" : "file" },
          success: true,
        });
        toolCache.invalidateByValue(target_path);
        return success(`Deleted ${stat.isDirectory() ? "directory" : "file"}: ${target_path}`, {
          path: target_path,
          type: stat.isDirectory() ? "dir" : "file",
        });
      } catch (e: any) {
        audit.record({
          action: "file.delete",
          tool: "delete_path",
          detail: { path: target_path },
          success: false,
          error: e.message,
        });
        if (e.code === "ENOENT")
          return fail(ErrorCode.PATH_NOT_FOUND, `Not found: ${target_path}`, { retryable: true, param: "target_path" });
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );
}
