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
import { resolveForRead, resolveForWrite } from "../path-policy.js";
import { ErrorCode, Errors, fail, success, type ToolResult, withErrorSchema } from "../result.js";
import {
  describeSafetyDecision,
  evaluateDestructiveAction,
  getSafetyProtocolVersion,
  guardDestructiveAction,
  type SafetyDecision,
} from "../safeguard.js";
import { validatePath } from "../security.js";
import { wrapHandler } from "../wrap.js";

const SAFETY_META = { safety_protocol_version: getSafetyProtocolVersion() as 2, latency_ms: 0 } as const;

function decisionFailure(toolName: string, description: string, decision: SafetyDecision): ToolResult {
  if (decision.status === "required") {
    return fail(ErrorCode.ELICITATION_REQUIRED, describeSafetyDecision(decision, toolName, description), {
      retryable: false,
      param: "target_path",
      suggestion: "Use a client with form Elicitation support (e.g. a desktop MCP client)",
      detail: {
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
      detail: { reason: decision.reason },
      meta: SAFETY_META,
    });
  }
  return fail(ErrorCode.INTERNAL_ERROR, "Unexpected safety decision", {
    retryable: false,
    meta: SAFETY_META,
  });
}

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
      // 源走读语义（real 解析重验），目标走 no-follow 写语义；cp/rename 以 real 执行
      const srcRes = await resolveForRead(source, "copy_move:source", "source", SAFETY_META);
      if (!srcRes.ok) return srcRes.result;
      const dstRes = await resolveForWrite(destination, "copy_move:destination", "destination", SAFETY_META);
      if (!dstRes.ok) return dstRes.result;
      const srcReal = srcRes.resolution.real;
      const dstReal = dstRes.resolution.real;

      const block = await guardDestructiveAction("copy_move", `${operation}: ${source} -> ${destination}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "operation" });

      try {
        await fs.mkdir(path.dirname(dstReal), { recursive: true });
        if (operation === "copy") {
          await fs.cp(srcReal, dstReal, { recursive: true });
        } else {
          await fs.rename(srcReal, dstReal);
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
      outputSchema: withErrorSchema(z.object({ path: z.string(), type: z.string() })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("delete_path", async ({ target_path, recursive }: DeletePathInput) => {
      const pathErr = validatePath(target_path, "delete_path");
      if (pathErr) {
        return fail(ErrorCode.PATH_FORBIDDEN, pathErr, {
          retryable: false,
          param: "target_path",
          meta: SAFETY_META,
        });
      }

      // symlink 特例：删除链接本身（unlink 不跟随，无越权落盘面），不走 no-follow 拒绝
      let lst: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      try {
        lst = await fs.lstat(target_path);
      } catch {
        lst = null;
      }
      const isSymlink = lst?.isSymbolicLink() === true;
      let realTarget = target_path;
      if (!isSymlink) {
        const resolved = await resolveForWrite(target_path, "delete_path", "target_path", SAFETY_META);
        if (!resolved.ok) return resolved.result;
        realTarget = resolved.resolution.real;
      }

      const description = `删除: ${target_path}`;
      const decision = await evaluateDestructiveAction("delete_path", description);
      if (decision.status !== "allow") return decisionFailure("delete_path", description, decision);

      try {
        let deletedType: string;
        if (isSymlink) {
          await fs.unlink(target_path);
          deletedType = "link";
        } else {
          const stat = await fs.stat(realTarget);
          if (stat.isDirectory()) {
            if (!recursive) {
              return fail(
                ErrorCode.VALIDATION_ERROR,
                `Cannot delete non-empty directory without recursive=true: ${target_path}`,
                { retryable: true, param: "recursive", suggestion: "Set recursive=true to delete directory contents" },
              );
            }
            await fs.rm(realTarget, { recursive: true, force: true });
            deletedType = "dir";
          } else {
            await fs.unlink(realTarget);
            deletedType = "file";
          }
        }
        logger.warn("delete_path", `deleted ${deletedType}`, target_path);
        audit.record({
          action: "file.delete",
          tool: "delete_path",
          detail: { path: target_path, type: deletedType },
          success: true,
        });
        toolCache.invalidateByValue(target_path);
        return success(
          `Deleted ${deletedType === "dir" ? "directory" : deletedType === "link" ? "link" : "file"}: ${target_path}`,
          {
            path: target_path,
            type: deletedType,
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
