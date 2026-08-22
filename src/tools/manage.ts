/**
 * 文件管理工具: copy_move, delete_path
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { audit } from "../audit.js";
import { toolCache } from "../cache.js";
import { isHeadlessPolicyEnabled, validateHeadlessDeleteTarget } from "../headless-policy.js";
import { logger } from "../logger.js";
import { ErrorCode, Errors, fail, success, type ToolResult, withErrorSchema } from "../result.js";
import {
  describeSafetyDecision,
  evaluateDestructiveAction,
  getConfirmationMode,
  getSafetyProtocolVersion,
  guardDestructiveAction,
  type SafetyDecision,
} from "../safeguard.js";
import { validatePath, validateRealPath } from "../security.js";
import { createDeletePreview, deleteWithPreview, WorkspaceDeleteError } from "../workspace-delete.js";
import { wrapHandler } from "../wrap.js";

const SAFETY_META = { safety_protocol_version: getSafetyProtocolVersion() as 2, latency_ms: 0 } as const;

function decisionFailure(toolName: string, description: string, decision: SafetyDecision): ToolResult {
  if (decision.status === "required") {
    return fail(ErrorCode.ELICITATION_REQUIRED, describeSafetyDecision(decision, toolName, description), {
      retryable: false,
      param: "target_path",
      suggestion:
        "Use a client with form Elicitation or configure MCP_CONFIRMATION_MODE=headless with MCP_ALLOWED_ROOTS",
      detail: {
        confirmation_mode: getConfirmationMode(),
        client_supports_elicitation: decision.clientSupportsElicitation,
      },
      meta: SAFETY_META,
    });
  }
  if (decision.status === "declined") {
    return fail(ErrorCode.ELICITATION_CANCELLED, describeSafetyDecision(decision, toolName, description), {
      retryable: false,
      param: "target_path",
      meta: SAFETY_META,
    });
  }
  if (decision.status === "blocked") {
    return fail(ErrorCode.SAFETY_BLOCKED, describeSafetyDecision(decision, toolName, description), {
      retryable: false,
      param: "target_path",
      detail: { reason: decision.reason, confirmation_mode: getConfirmationMode() },
      meta: SAFETY_META,
    });
  }
  return fail(ErrorCode.INTERNAL_ERROR, "Unexpected safety decision", {
    retryable: false,
    meta: SAFETY_META,
  });
}

function workspaceDeleteFailure(error: unknown, targetPath: string): ToolResult {
  if (error instanceof WorkspaceDeleteError) {
    return fail(error.code, error.message, {
      retryable: error.retryable,
      suggestion: error.suggestion,
      param: "target_path",
      detail: error.detail,
      meta: SAFETY_META,
    });
  }
  const mapped = mapFsError(error, targetPath, "target_path");
  if (!mapped.ok) mapped.meta = SAFETY_META;
  return mapped;
}

async function validateDeleteInput(targetPath: string): Promise<ToolResult | null> {
  const pathErr = validatePath(targetPath, "delete_path");
  if (pathErr) {
    return fail(ErrorCode.PATH_FORBIDDEN, pathErr, {
      retryable: false,
      param: "target_path",
      meta: SAFETY_META,
    });
  }
  const realErr = await validateRealPath(targetPath, "delete_path");
  if (realErr) {
    return fail(ErrorCode.PATH_FORBIDDEN, realErr, {
      retryable: false,
      param: "target_path",
      meta: SAFETY_META,
    });
  }
  if (isHeadlessPolicyEnabled()) {
    const boundaryError = await validateHeadlessDeleteTarget(targetPath);
    if (boundaryError) {
      return fail(ErrorCode.SAFETY_BLOCKED, boundaryError, {
        retryable: false,
        param: "target_path",
        detail: { reason: "headless_root" },
        meta: SAFETY_META,
      });
    }
  }
  return null;
}

const DeletePreviewSchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
  recursive: z.boolean(),
  file_count: z.number().int().nonnegative(),
  directory_count: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  snapshot: z.object({
    algorithm: z.literal("sha256-lstat-v1"),
    entry_count: z.number().int().positive(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  preview_id: z.string().uuid(),
  expires_at: z.string(),
});
type DeletePreviewResult = z.infer<typeof DeletePreviewSchema>;

/** 统一 fs 错误：ENOENT -> PATH_NOT_FOUND */
function mapFsError(e: unknown, p: string, param: string) {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;
  if (code === "ENOENT") return fail(ErrorCode.PATH_NOT_FOUND, `Not found: ${p}`, { retryable: true, param });
  return Errors.executionFailed(msg);
}

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
      outputSchema: withErrorSchema(z.object({ source: z.string(), destination: z.string(), operation: z.string() })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("copy_move", async ({ source, destination, operation }: CopyMoveInput) => {
      for (const [p, label] of [
        [source, "source"],
        [destination, "destination"],
      ] as const) {
        const err = validatePath(p, `copy_move:${label}`);
        if (err) return fail(ErrorCode.PATH_FORBIDDEN, err, { retryable: false, param: label });
        // 真实路径校验（防 symlink 指向系统目录）；destination 可能不存在，解析失败放行
        const realErr = await validateRealPath(p, `copy_move:${label}`);
        if (realErr) return fail(ErrorCode.PATH_FORBIDDEN, realErr, { retryable: false, param: label });
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
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.record({
          action: "file.move",
          tool: "copy_move",
          detail: { source, destination, operation },
          success: false,
          error: msg,
        });
        return Errors.executionFailed(msg);
      }
    }),
  );

  const DeletePreviewInput = z.object({
    target_path: z.string().describe("Path to preview for deletion"),
    recursive: z.boolean().optional().describe("Preview directory recursively, default false"),
  });
  type DeletePreviewInput = z.infer<typeof DeletePreviewInput>;

  server.registerTool(
    "delete_preview",
    {
      title: "Preview Delete",
      description: "Inspect a file or directory deletion without changing the filesystem.",
      inputSchema: DeletePreviewInput,
      outputSchema: withErrorSchema(DeletePreviewSchema),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("delete_preview", async ({ target_path, recursive }: DeletePreviewInput) => {
      const pathErr = validatePath(target_path, "delete_preview");
      if (pathErr) {
        return fail(ErrorCode.PATH_FORBIDDEN, pathErr, {
          retryable: false,
          param: "target_path",
          meta: SAFETY_META,
        });
      }
      const realErr = await validateRealPath(target_path, "delete_preview");
      if (realErr) {
        return fail(ErrorCode.PATH_FORBIDDEN, realErr, {
          retryable: false,
          param: "target_path",
          meta: SAFETY_META,
        });
      }
      try {
        const preview = await createDeletePreview(target_path, recursive === true);
        return success(`Delete preview ready: ${preview.path}`, preview satisfies DeletePreviewResult, {
          safety_protocol_version: getSafetyProtocolVersion(),
        });
      } catch (error) {
        return workspaceDeleteFailure(error, target_path);
      }
    }),
  );

  const DeletePathInput = z.object({
    target_path: z.string().describe("Path to delete"),
    recursive: z.boolean().optional().describe("Delete directory recursively, default false"),
    preview_id: z.string().uuid().optional().describe("Required for headless workspace-delete"),
  });
  type DeletePathInput = z.infer<typeof DeletePathInput>;

  server.registerTool(
    "delete_path",
    {
      title: "Delete Path",
      description: "Delete a file or directory (use with caution!).",
      inputSchema: DeletePathInput,
      outputSchema: withErrorSchema(z.object({ path: z.string(), type: z.string() })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("delete_path", async ({ target_path, recursive, preview_id }: DeletePathInput) => {
      const inputError = await validateDeleteInput(target_path);
      if (inputError) return inputError;

      const description = `删除: ${target_path}`;
      const decision = await evaluateDestructiveAction("delete_path", description);
      if (decision.status !== "allow") return decisionFailure("delete_path", description, decision);

      if (isHeadlessPolicyEnabled()) {
        if (!preview_id) {
          return fail(ErrorCode.VALIDATION_ERROR, "Headless delete requires a preview_id", {
            retryable: true,
            param: "preview_id",
            suggestion: "Call delete_preview first",
            meta: SAFETY_META,
          });
        }
        try {
          const deleted = await deleteWithPreview(target_path, recursive === true, preview_id);
          logger.warn("delete_path", `deleted ${deleted.type}`, deleted.path);
          audit.record({
            action: "file.delete",
            tool: "delete_path",
            detail: {
              path: deleted.path,
              type: deleted.type,
              authorization_source: "headless",
              safety_protocol_version: getSafetyProtocolVersion(),
            },
            success: true,
          });
          toolCache.invalidateByValue(target_path);
          return success(`Deleted ${deleted.type}: ${deleted.path}`, deleted, {
            safety_protocol_version: getSafetyProtocolVersion(),
          });
        } catch (error) {
          return workspaceDeleteFailure(error, target_path);
        }
      }

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
        return success(
          `Deleted ${stat.isDirectory() ? "directory" : "file"}: ${target_path}`,
          {
            path: target_path,
            type: stat.isDirectory() ? "dir" : "file",
          },
          SAFETY_META,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        audit.record({
          action: "file.delete",
          tool: "delete_path",
          detail: { path: target_path },
          success: false,
          error: msg,
        });
        const mapped = mapFsError(e, target_path, "target_path");
        if (!mapped.ok) mapped.meta = SAFETY_META;
        return mapped;
      }
    }),
  );
}
