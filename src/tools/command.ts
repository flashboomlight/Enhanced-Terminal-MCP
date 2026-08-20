/**
 * 命令执行工具: execute_command, batch_execute, watch_command
 * 使用统一 ToolResult 协议 + MCP CallToolResult 兼容转换
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { adaptiveTimeout } from "../adaptive.js";
import { audit } from "../audit.js";
import { checkCommandPolicy, classifyPolicyReason, getCommandPolicyMode } from "../command-policy.js";
import { logger } from "../logger.js";
import { pageCache } from "../paging.js";
import { checkRateLimit, commandRateLimit } from "../ratelimit.js";
import { ErrorCode, Errors, fail, success, type ToolResult, withErrorSchema } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { session } from "../session.js";
import { buildShellInvocation, getShellSpec, shellResolutionFail } from "../shell.js";
import { spawnStream } from "../stream.js";
import { wrapHandler } from "../wrap.js";

/** 前置安全预检：策略（hardBlock + blocklist/allow）。返回错误 ToolResult 或 null（通过） */
function precheckCommand(command: string, param: string): ToolResult | null {
  const reason = checkCommandPolicy(command);
  if (!reason) return null;
  const category = classifyPolicyReason(reason);
  const policyMode = getCommandPolicyMode();
  audit.record({
    action: "safety.block",
    tool: "execute_command",
    detail: { command, reason, category, policyMode },
    success: false,
    error: reason,
  });
  return Errors.commandBlocked(command, reason, param);
}

/** batch 限流：batch=整批 1 token（默认）；per_command=按条数消费 */
function getBatchRateMode(): "batch" | "per_command" {
  const raw = (process.env.MCP_BATCH_RATE_MODE || "batch").toLowerCase().trim();
  return raw === "per_command" || raw === "per-command" || raw === "command" ? "per_command" : "batch";
}

/** 统一记录命令执行审计（成功/失败） */
function recordCommandAudit(
  tool: string,
  command: string,
  detail: Record<string, unknown>,
  success: boolean,
  error?: string,
): void {
  audit.record({ action: "command.execute", tool, detail: { command, ...detail }, success, error });
}

function getCommandMaxOutputBytes(): number {
  const configured = parseInt(process.env.MCP_COMMAND_MAX_OUTPUT_BYTES || "", 10);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1024, configured);
  }
  return 50 * 1024 * 1024;
}

function getSessionEnv(): Record<string, string> {
  return session.get().env;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerCommandTools(server: McpServer) {
  // ====================================================================
  const ExecuteCommandInput = z.object({
    command: z.string().optional().describe("The command to execute. Required unless cache_id is provided."),
    cache_id: z.string().optional().describe("Read a page from a previous paged command output without re-executing."),
    cwd: z.string().optional().describe("Working directory (optional)"),
    timeout: z.number().optional().describe("Timeout in ms, default 30000"),
    page: z.number().int().min(1).optional().describe("Page number to read from paged output, default 1"),
    pageSize: z.number().int().min(1).max(10000).optional().describe("Characters per page, default 2000, max 10000"),
  });
  type ExecuteCommandInput = z.infer<typeof ExecuteCommandInput>;

  server.registerTool(
    "execute_command",
    {
      title: "Execute Terminal Command",
      description: "Execute a single shell/terminal command. Returns structured result with exit code and stderr.",
      inputSchema: ExecuteCommandInput,
      outputSchema: withErrorSchema(
        z.object({
          stdout: z.string(),
          stderr: z.string(),
          exit_code: z
            .number()
            .nullable()
            .describe("Process exit code; null when undetermined (e.g. timed out before exit)"),
          timed_out: z.boolean(),
          cache_id: z.string().optional(),
          page: z.number().optional(),
          total_pages: z.number().optional(),
          page_size: z.number().optional(),
          total_chars: z.number().optional(),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    wrapHandler("execute_command", async ({ command, cache_id, cwd, timeout, page, pageSize }: ExecuteCommandInput) => {
      const t0 = Date.now();
      if (cache_id) {
        try {
          const pageResult = await pageCache.get(cache_id, page || 1, pageSize);
          if (!pageResult) {
            return fail(ErrorCode.PATH_NOT_FOUND, `Paged output not found or page is out of range: ${cache_id}`, {
              retryable: true,
              param: "cache_id",
            });
          }
          return success(
            pageResult.content,
            {
              stdout: pageResult.content,
              stderr: pageResult.stderr,
              exit_code: pageResult.exit_code,
              timed_out: false,
              cache_id: pageResult.cache_id,
              page: pageResult.page,
              total_pages: pageResult.total_pages,
              page_size: pageResult.page_size,
              total_chars: pageResult.total_chars,
            },
            { latency_ms: Date.now() - t0, page: pageResult.page, total_pages: pageResult.total_pages },
          );
        } catch (e: unknown) {
          return fail(ErrorCode.EXECUTION_FAILED, errMsg(e) || "Failed to read paged output", { retryable: true });
        }
      }

      if (!command) {
        return fail(ErrorCode.VALIDATION_ERROR, "command is required unless cache_id is provided", {
          retryable: true,
          param: "command",
        });
      }

      const dp = precheckCommand(command, "command");
      if (dp) return dp;

      const rateErr = checkRateLimit(commandRateLimit, "execute_command");
      if (rateErr)
        return fail(ErrorCode.EXECUTION_FAILED, rateErr, {
          retryable: true,
          suggestion: "Wait ~100ms and retry (token bucket refills 10/s)",
        });

      const block = await guardDestructiveAction("execute_command", `执行命令: ${command}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "command" });

      try {
        const shellSpec = await getShellSpec();
        const inv = buildShellInvocation(command, shellSpec);
        const effectiveCwd = cwd || session.getCwd();
        const effectiveTimeout = timeout || adaptiveTimeout("execute_command");
        const result = await spawnStream(inv.file, inv.args, {
          timeout: effectiveTimeout,
          cwd: effectiveCwd,
          env: getSessionEnv(),
          maxOutput: getCommandMaxOutputBytes(),
        });
        session.pushHistory(command);

        if (result.timedOut) {
          audit.record({
            action: "command.execute",
            tool: "execute_command",
            detail: { command, cwd: effectiveCwd, timedOut: true },
            success: false,
            error: "Command timed out",
          });
          return fail(ErrorCode.TIMEOUT, "Command timed out", {
            retryable: true,
            param: "timeout",
            suggestion: "Use a simpler command or increase timeout",
          });
        }

        if (result.truncated) {
          audit.record({
            action: "command.execute",
            tool: "execute_command",
            detail: { command, cwd: effectiveCwd, maxOutputBytes: getCommandMaxOutputBytes() },
            success: false,
            error: "Command output exceeded max output limit",
          });
          const partial = (result.stdout || "").slice(0, 500);
          return fail(
            ErrorCode.EXECUTION_FAILED,
            `Command output exceeded MCP_COMMAND_MAX_OUTPUT_BYTES (${getCommandMaxOutputBytes()} bytes); output truncated.\n[partial stdout]:\n${partial}`,
            {
              retryable: true,
              param: "command",
              suggestion: "Write output to a file, request a smaller output, or raise MCP_COMMAND_MAX_OUTPUT_BYTES",
            },
          );
        }

        const output = result.stdout || "(no output)";
        const errInfo = result.stderr ? `\n[stderr]:\n${result.stderr.slice(0, 500)}` : "";

        if (result.exitCode !== 0) {
          audit.record({
            action: "command.execute",
            tool: "execute_command",
            detail: { command, cwd: effectiveCwd, exitCode: result.exitCode },
            success: false,
            error: result.stderr?.slice(0, 200) || `exit ${result.exitCode}`,
          });
          return fail(
            ErrorCode.EXECUTION_FAILED,
            `Command failed (exit ${result.exitCode})\n[stdout]:\n${output.slice(0, 500)}${errInfo}`,
            { retryable: true },
          );
        }
        const defaultPageSize = 2000;
        const requestedPageSize = pageSize || defaultPageSize;
        const needsPaging = page !== undefined || output.length > requestedPageSize;

        if (needsPaging) {
          const cache = await pageCache.cache(
            command,
            effectiveCwd,
            result.exitCode ?? 0,
            output,
            result.stderr || "",
            requestedPageSize,
          );
          const pageResult = await pageCache.get(cache.id, page || 1, requestedPageSize);
          if (!pageResult) {
            return fail(ErrorCode.VALIDATION_ERROR, `Invalid page: ${page}`, {
              retryable: true,
              param: "page",
              detail: { total_pages: cache.totalPages },
            });
          }
          audit.record({
            action: "command.execute",
            tool: "execute_command",
            detail: {
              command,
              cwd: effectiveCwd,
              exitCode: 0,
              latency_ms: Date.now() - t0,
              page: pageResult.page,
              total_pages: pageResult.total_pages,
            },
            success: true,
          });
          const recordedExit = result.exitCode ?? 0;
          return success(
            pageResult.content,
            {
              stdout: pageResult.content,
              stderr: result.stderr,
              exit_code: recordedExit,
              timed_out: false,
              cache_id: pageResult.cache_id,
              page: pageResult.page,
              total_pages: pageResult.total_pages,
              page_size: pageResult.page_size,
              total_chars: pageResult.total_chars,
            },
            { latency_ms: Date.now() - t0, page: pageResult.page, total_pages: pageResult.total_pages },
          );
        }

        audit.record({
          action: "command.execute",
          tool: "execute_command",
          detail: { command, cwd: effectiveCwd, exitCode: 0, latency_ms: Date.now() - t0 },
          success: true,
        });
        return success(
          output,
          {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exitCode ?? 0,
            timed_out: false,
          },
          { latency_ms: Date.now() - t0 },
        );
      } catch (e: unknown) {
        const msg = errMsg(e) || "Unknown error";
        recordCommandAudit("execute_command", command, { cwd: cwd || session.getCwd() }, false, msg);
        return shellResolutionFail(e) ?? fail(ErrorCode.EXECUTION_FAILED, msg, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const BatchExecuteInput = z.object({
    commands: z.array(z.string()).describe("Array of commands to execute"),
    cwd: z.string().optional().describe("Working directory"),
    stop_on_error: z.boolean().optional().describe("Stop if a command fails, default true"),
    parallel: z.boolean().optional().describe("Execute commands in parallel (no dependencies), default false"),
  });
  type BatchExecuteInput = z.infer<typeof BatchExecuteInput>;

  server.registerTool(
    "batch_execute",
    {
      title: "Batch Execute Commands",
      description: "Execute multiple commands sequentially. Stops on first error if stop_on_error is true (default).",
      inputSchema: BatchExecuteInput,
      outputSchema: withErrorSchema(
        z.object({
          results: z.array(
            z.object({
              command: z.string(),
              stdout: z.string(),
              stderr: z.string(),
              ok: z.boolean(),
              latency_ms: z.number(),
            }),
          ),
          summary: z.string(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("batch_execute", async ({ commands, cwd, stop_on_error, parallel }: BatchExecuteInput) => {
      const t0 = Date.now();
      const stop = stop_on_error !== false;
      const isParallel = parallel === true;

      for (const cmd of commands) {
        const blocked = precheckCommand(cmd, "commands");
        if (blocked) return blocked;
      }

      const block = await guardDestructiveAction("batch_execute", `批量执行 ${commands.length} 条命令`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "commands" });

      // 默认整批 1 token；MCP_BATCH_RATE_MODE=per_command 时按条消费
      const batchMode = getBatchRateMode();
      if (batchMode === "per_command") {
        for (let i = 0; i < commands.length; i++) {
          const rateErr = checkRateLimit(commandRateLimit, "batch_execute");
          if (rateErr)
            return fail(ErrorCode.EXECUTION_FAILED, rateErr, {
              retryable: true,
              suggestion: "Wait ~100ms and retry (token bucket refills 10/s); or set MCP_BATCH_RATE_MODE=batch",
              detail: { batch_rate_mode: batchMode, consumed: i, total: commands.length },
            });
        }
      } else {
        const rateErr = checkRateLimit(commandRateLimit, "batch_execute");
        if (rateErr)
          return fail(ErrorCode.EXECUTION_FAILED, rateErr, {
            retryable: true,
            suggestion: "Wait ~100ms and retry (token bucket refills 10/s)",
            detail: { batch_rate_mode: batchMode },
          });
      }

      try {
        const shellSpec = await getShellSpec();
        const results: Array<{ command: string; stdout: string; stderr: string; ok: boolean; latency_ms: number }> = [];
        let allOk = true;

        const execOne = async (cmd: string, idx: number) => {
          const ct0 = Date.now();
          try {
            logger.info("batch_execute", `step ${idx + 1}/${commands.length}`, cmd);
            const inv = buildShellInvocation(cmd, shellSpec);
            const r = await spawnStream(inv.file, inv.args, {
              timeout: 30000,
              cwd: cwd || session.getCwd(),
              env: getSessionEnv(),
              maxOutput: getCommandMaxOutputBytes(),
            });
            return {
              command: cmd,
              stdout: r.stdout || "",
              stderr: r.truncated
                ? `${r.stderr || ""}${r.stderr ? "\n" : ""}[OUTPUT_TRUNCATED] Command output exceeded MCP_COMMAND_MAX_OUTPUT_BYTES`
                : r.stderr || "",
              ok: !r.truncated && r.exitCode === 0,
              latency_ms: Date.now() - ct0,
            };
          } catch (e: unknown) {
            return { command: cmd, stdout: "", stderr: errMsg(e) || "failed", ok: false, latency_ms: Date.now() - ct0 };
          }
        };

        if (isParallel) {
          // 并发限制为 4，避免同时 spawn 过多进程
          const concurrency = 4;
          const settled: typeof results = [];
          for (let i = 0; i < commands.length; i += concurrency) {
            const batch = commands.slice(i, i + concurrency);
            const batchResults = await Promise.all(batch.map((cmd: string, j: number) => execOne(cmd, i + j)));
            settled.push(...batchResults);
          }
          results.push(...settled);
          allOk = settled.every((r) => r.ok);
        } else {
          for (let i = 0; i < commands.length; i++) {
            const r = await execOne(commands[i], i);
            results.push(r);
            if (!r.ok) {
              allOk = false;
              if (stop) break;
            }
          }
        }

        session.pushHistory(commands.join("; "));
        const summary = allOk
          ? `All ${results.length} commands OK`
          : `${results.filter((r) => r.ok).length}/${results.length} commands OK`;
        audit.record({
          action: "command.execute",
          tool: "batch_execute",
          detail: { commands, parallel: isParallel, allOk },
          success: allOk,
          error: allOk ? undefined : "Some commands failed",
        });
        return success(summary, { results, summary }, { latency_ms: Date.now() - t0 });
      } catch (e: unknown) {
        return (
          shellResolutionFail(e) ?? fail(ErrorCode.EXECUTION_FAILED, errMsg(e) || "Batch failed", { retryable: true })
        );
      }
    }),
  );

  // ====================================================================
  const WatchCommandInput = z.object({
    command: z.string().describe("The command to run"),
    duration: z.number().optional().describe("Max duration in ms, default 5000"),
    cwd: z.string().optional().describe("Working directory"),
  });
  type WatchCommandInput = z.infer<typeof WatchCommandInput>;

  server.registerTool(
    "watch_command",
    {
      title: "Watch Command Output",
      description: "Execute a command and capture output for a limited duration. Useful for real-time monitoring.",
      inputSchema: WatchCommandInput,
      outputSchema: withErrorSchema(
        z.object({
          output: z.string(),
          captured_ms: z.number(),
          exit_code: z.number().nullable().optional(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("watch_command", async ({ command, duration, cwd }: WatchCommandInput) => {
      const t0 = Date.now();
      const blocked = precheckCommand(command, "command");
      if (blocked) return blocked;

      const block = await guardDestructiveAction("watch_command", `监控命令: ${command}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "command" });

      try {
        const shellSpec = await getShellSpec();
        const inv = buildShellInvocation(command, shellSpec);
        const effectiveCwd = cwd || session.getCwd();
        const result = await spawnStream(inv.file, inv.args, {
          timeout: duration || 5000,
          cwd: effectiveCwd,
          env: getSessionEnv(),
          maxOutput: getCommandMaxOutputBytes(),
        });
        const output = result.stdout || "(no output)";
        if (result.timedOut) {
          audit.record({
            action: "command.execute",
            tool: "watch_command",
            detail: { command, cwd: effectiveCwd, timedOut: true },
            success: false,
            error: "Watch timed out",
          });
          return success(
            `$ ${command}\n(timed out)\n${output}`,
            { output, captured_ms: duration || 5000, exit_code: result.exitCode },
            { latency_ms: Date.now() - t0 },
          );
        }
        if (result.truncated) {
          audit.record({
            action: "command.execute",
            tool: "watch_command",
            detail: { command, cwd: effectiveCwd, maxOutputBytes: getCommandMaxOutputBytes() },
            success: false,
            error: "Watch output exceeded max output limit",
          });
          return fail(
            ErrorCode.EXECUTION_FAILED,
            `Watch output exceeded MCP_COMMAND_MAX_OUTPUT_BYTES (${getCommandMaxOutputBytes()} bytes)`,
            {
              retryable: true,
              param: "command",
              suggestion: "Use a narrower command or raise MCP_COMMAND_MAX_OUTPUT_BYTES",
            },
          );
        }
        if (result.exitCode !== 0) {
          audit.record({
            action: "command.execute",
            tool: "watch_command",
            detail: { command, cwd: effectiveCwd, exitCode: result.exitCode },
            success: false,
            error: result.stderr?.slice(0, 200) || `exit ${result.exitCode}`,
          });
          return fail(
            ErrorCode.EXECUTION_FAILED,
            `Watch command failed (exit ${result.exitCode})\n[stdout]:\n${output.slice(0, 500)}${
              result.stderr ? `\n[stderr]:\n${result.stderr.slice(0, 500)}` : ""
            }`,
            { retryable: true },
          );
        }
        audit.record({
          action: "command.execute",
          tool: "watch_command",
          detail: { command, cwd: effectiveCwd, exitCode: result.exitCode },
          success: true,
        });
        return success(
          `$ ${command}\n${output}`,
          { output, captured_ms: Date.now() - t0, exit_code: result.exitCode },
          { latency_ms: Date.now() - t0 },
        );
      } catch (e: unknown) {
        const msg = errMsg(e) || "Watch failed";
        recordCommandAudit("watch_command", command, {}, false, msg);
        return shellResolutionFail(e) ?? fail(ErrorCode.EXECUTION_FAILED, msg, { retryable: true });
      }
    }),
  );
}
