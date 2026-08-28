/**
 * 命令执行工具: execute_command, batch_execute, watch_command
 * 使用统一 ToolResult 协议 + MCP CallToolResult 兼容转换
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { adaptiveTimeout } from "../adaptive.js";
import { audit } from "../audit.js";
import {
  buildBatchBudget,
  commandBudgetSkipReason,
  commandInputBytes,
  MAX_BATCH_INPUT_BYTES,
  MAX_BATCH_ITEMS,
  MAX_COMMAND_BYTES,
  MAX_COMMAND_CHARS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_WATCH_DURATION_MS,
  validateBoundedCommandInput,
} from "../command-budget.js";
import {
  type CommandOutputLimits,
  type CommandOutputRun,
  getCommandOutputLimits,
  runCommandOutput,
} from "../command-output.js";
import { checkCommandPolicy, classifyPolicyReason, getCommandPolicyMode } from "../command-policy.js";
import { type CommandGuardContext, getCommandConfirmationMode } from "../command-risk.js";
import { boundedArray, boundedString, finiteInt, type RequestContext } from "../hardening-contract.js";
import { logger } from "../logger.js";
import { PageCacheCorruptError, PageCacheReadError, pageCache } from "../paging.js";
import { ProcessSupervisorError } from "../process-supervisor.js";
import { checkRateLimit, commandRateLimit } from "../ratelimit.js";
import {
  type BatchCommandResult,
  type CommandOutputEnvelope,
  commandOutputSchema,
  completedBatchSchema,
  ErrorCode,
  Errors,
  fail,
  type StructuredError,
  skippedBatchSchema,
  success,
  type ToolResult,
  withErrorSchema,
} from "../result.js";
import { describeSafetyDecision, guardCommandByRisk, guardDestructiveAction } from "../safeguard.js";
import { session } from "../session.js";
import { buildShellInvocation, getShellSpec, shellResolutionFail } from "../shell.js";
import { registerManagedTool } from "../tool-registry.js";
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

/**
 * 命令安全闸：risk-gated 走 guardCommandByRisk 分级确认（拒绝体附风险原因），all 走工具级确认（现状）。
 * 返回 null = 放行；否则为已构造好的拒绝 ToolResult。
 */
async function commandSafetyGate(
  toolName: "execute_command" | "batch_execute" | "watch_command",
  command: string,
  description: string,
  param: "command" | "commands",
  context: CommandGuardContext = {},
): Promise<ToolResult | null> {
  if (getCommandConfirmationMode() !== "risk-gated") {
    const block = await guardDestructiveAction(toolName, description);
    return block ? fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param }) : null;
  }
  const { decision, risk } = await guardCommandByRisk(toolName, command, context);
  if (decision.status === "allow") return null;
  const reasonNote = risk.level === "heavy" && risk.reason ? `\n风险原因: ${risk.reason}` : "";
  if (decision.status === "required") {
    return fail(ErrorCode.ELICITATION_REQUIRED, describeSafetyDecision(decision, toolName, description) + reasonNote, {
      retryable: false,
      param,
      detail: { client_supports_elicitation: decision.clientSupportsElicitation },
    });
  }
  if (decision.status === "declined") {
    return fail(ErrorCode.ELICITATION_CANCELLED, describeSafetyDecision(decision, toolName, description) + reasonNote, {
      retryable: false,
      param,
    });
  }
  return fail(ErrorCode.SAFETY_BLOCKED, describeSafetyDecision(decision, toolName, description) + reasonNote, {
    retryable: false,
    param,
    detail: { reason: decision.reason },
  });
}

/** 解析命令输出限额；配置非法时返回统一拒绝结果（param 仅 batch 路径携带） */
function resolveCommandLimits(
  param?: string,
): { limits: CommandOutputLimits; reject: null } | { limits: null; reject: ToolResult } {
  const { limits, error } = getCommandOutputLimits();
  if (!limits) {
    return {
      limits: null,
      reject: fail(ErrorCode.VALIDATION_ERROR, error ?? "Invalid command output limits configuration", {
        retryable: false,
        ...(param ? { param } : {}),
      }),
    };
  }
  return { limits, reject: null };
}

/** 解析 shell spec 并构建调用参数；cwd 未指定时回退会话 cwd */
async function prepareInvocation(command: string, cwd?: string) {
  const shellSpec = await getShellSpec();
  const inv = buildShellInvocation(command, shellSpec);
  return { inv, effectiveCwd: cwd || session.getCwd() };
}

/** 命令收尾统一路径：错误判定 + envelope 构建（capturedMs 以 t0 起算）；subject 仅 watch 定制错误文案 */
function finishCommandEnvelope(result: CommandOutputRun, t0: number, subject?: string) {
  const capturedMs = Date.now() - t0;
  const error = commandError(result, subject);
  const ok = error === undefined;
  const envelope = buildCommandEnvelope(result, capturedMs, ok);
  if (error) envelope.error = error;
  return { capturedMs, error, ok, envelope };
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

function getSessionEnv(): Record<string, string> {
  return session.get().env;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 将 supervisor 的 capacity/abort 失败映射为工具层结构化结果。 */
function processSupervisorFailure(error: unknown): ToolResult | null {
  if (!(error instanceof ProcessSupervisorError)) return null;
  if (error.code === "ABORT_ERR") return Errors.cancelled(error.message);
  if (error.code === "RESOURCE_LIMIT") return Errors.resourceLimit(error.message);
  return fail(ErrorCode.EXECUTION_FAILED, error.message, { retryable: true });
}

/** 将共享命令结果映射为统一机器可读 envelope。 */
function buildCommandEnvelope(result: CommandOutputRun, capturedMs: number, ok: boolean): CommandOutputEnvelope {
  const stdoutBytes = result.stdoutRetainedBytes;
  const stderrBytes = result.stderrRetainedBytes;
  const totalOutputBytes = result.stdoutActualBytes + result.stderrActualBytes;
  const retainedOutputBytes = stdoutBytes + stderrBytes;
  const totalChars = result.cachePage?.total_chars ?? result.stdoutRetainedChars;
  const envelope: CommandOutputEnvelope = {
    ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated || result.stderrTruncated,
    stdout_truncated: result.truncated,
    stderr_truncated: result.stderrTruncated,
    paged: result.paged,
    total_output_bytes: totalOutputBytes,
    retained_output_bytes: retainedOutputBytes,
    stdout_total_bytes: result.stdoutActualBytes,
    stdout_retained_bytes: stdoutBytes,
    stderr_total_bytes: result.stderrActualBytes,
    stderr_retained_bytes: stderrBytes,
    total_chars: result.secretDetected ? 0 : totalChars,
    stdout_encoding: result.stdoutEncoding,
    stderr_encoding: result.stderrEncoding,
    capture_limit_reached: result.captureLimitReached || undefined,
    captured_ms: capturedMs,
  };
  if (result.cache) {
    envelope.cache_id = result.cache.id;
    envelope.page = result.cachePage?.page ?? 1;
    envelope.total_pages = result.cachePage?.total_pages ?? result.cache.totalPages;
    envelope.page_size = result.cachePage?.page_size ?? result.cache.pageSize;
  }
  if (result.cacheDisabledReason) envelope.cache_disabled_reason = result.cacheDisabledReason;
  return envelope;
}

/** 将分页读取结果映射为 envelope；读取成功不继承 MCP isError。 */
function buildCachedEnvelope(
  pageResult: Awaited<ReturnType<typeof pageCache.read>>,
  capturedMs: number,
): CommandOutputEnvelope {
  const originalError = pageResult.error
    ? ({
        code: Object.values(ErrorCode).includes(pageResult.error.code as (typeof ErrorCode)[keyof typeof ErrorCode])
          ? (pageResult.error.code as (typeof ErrorCode)[keyof typeof ErrorCode])
          : ErrorCode.EXECUTION_FAILED,
        message: pageResult.error.message,
        retryable: pageResult.error.retryable,
        suggestion: pageResult.error.suggestion,
        param: pageResult.error.param,
        detail:
          pageResult.error.code === ErrorCode.EXECUTION_FAILED || pageResult.error.code === ErrorCode.TIMEOUT
            ? pageResult.error.detail
            : { cache_error_code: pageResult.error.code, detail: pageResult.error.detail },
      } satisfies StructuredError)
    : undefined;
  return {
    ok: pageResult.error === undefined && pageResult.exit_code === 0 && !pageResult.timed_out,
    stdout: pageResult.content,
    stderr: pageResult.stderr,
    exit_code: pageResult.exit_code,
    timed_out: pageResult.timed_out,
    cancelled: false,
    truncated: pageResult.truncated,
    stdout_truncated: pageResult.stdout_truncated,
    stderr_truncated: pageResult.stderr_truncated,
    paged: true,
    total_output_bytes: pageResult.total_output_bytes,
    retained_output_bytes: pageResult.retained_output_bytes,
    stdout_total_bytes: pageResult.stdout_total_bytes,
    stdout_retained_bytes: pageResult.stdout_retained_bytes,
    stderr_total_bytes: pageResult.stderr_total_bytes,
    stderr_retained_bytes: pageResult.stderr_retained_bytes,
    total_chars: pageResult.total_chars,
    stdout_encoding: pageResult.stdout_encoding,
    stderr_encoding: pageResult.stderr_encoding,
    cache_id: pageResult.cache_id,
    page: pageResult.page,
    total_pages: pageResult.total_pages,
    page_size: pageResult.page_size,
    capture_limit_reached: pageResult.capture_limit_reached || undefined,
    captured_ms: capturedMs,
    error: originalError,
  };
}

/** 将命令事实转为共享错误体；不把 secret 原文写入 detail。 */
function commandError(result: CommandOutputRun, subject = "Command"): StructuredError | undefined {
  if (result.secretDetected && result.secretTier === "strict") {
    return { code: ErrorCode.SECRET_DETECTED, message: "Command output contained a secret pattern", retryable: false };
  }
  if (result.terminationFailed) {
    return {
      code: ErrorCode.EXECUTION_FAILED,
      message: `${subject} termination failed`,
      retryable: true,
      detail: { watch_termination_failed: true },
    };
  }
  if (result.cancelled) return { code: ErrorCode.CANCELLED, message: `${subject} cancelled`, retryable: true };
  if (result.timedOut) return { code: ErrorCode.TIMEOUT, message: `${subject} timed out`, retryable: true };
  if (result.captureLimitReached) return undefined;
  if (result.exitCode !== null && result.exitCode !== 0) {
    return {
      code: ErrorCode.EXECUTION_FAILED,
      message: `${subject} failed (exit ${result.exitCode})`,
      retryable: true,
    };
  }
  return undefined;
}

/** 将 cache read 的异常映射为 execute_command 的结构化失败。 */
function cacheReadFailure(error: unknown, cacheId: string): ToolResult {
  if (error instanceof PageCacheCorruptError) {
    return fail(ErrorCode.EXECUTION_FAILED, error.message, {
      retryable: false,
      param: "cache_id",
      detail: { cache_corrupt: true, code: error.code },
    });
  }
  if (error instanceof PageCacheReadError) {
    if (error.code === "cache_page_out_of_range") {
      return fail(ErrorCode.VALIDATION_ERROR, error.message, {
        retryable: true,
        param: "page",
        detail: error.detail,
      });
    }
    return fail(ErrorCode.PATH_NOT_FOUND, error.message, {
      retryable: error.retryable,
      param: "cache_id",
      detail: { cache_id: cacheId },
    });
  }
  const code = (error as { code?: string }).code;
  if (code === "temp_lock_timeout") {
    return fail(ErrorCode.EXECUTION_FAILED, errMsg(error), {
      retryable: true,
      param: "cache_id",
      detail: { cache_lock_timeout: true },
    });
  }
  return fail(ErrorCode.EXECUTION_FAILED, errMsg(error) || "Failed to read paged output", {
    retryable: true,
    param: "cache_id",
  });
}

/** 记录不含 command/cwd/content 的分页读取审计。 */
function recordOutputRead(cacheId: string, page: number, pageResult: CommandOutputEnvelope): void {
  audit.record({
    action: "command.output.read",
    tool: "execute_command",
    detail: {
      cache_id: cacheId,
      page,
      stdout_bytes: pageResult.stdout_retained_bytes,
      stderr_bytes: pageResult.stderr_retained_bytes,
      read_bytes: pageResult.stdout_retained_bytes + (page === 1 ? pageResult.stderr_retained_bytes : 0),
    },
    success: true,
  });
}

export function registerCommandTools(server: McpServer) {
  // ====================================================================
  const ExecuteCommandInput = z.object({
    command: boundedString(MAX_COMMAND_CHARS, MAX_COMMAND_BYTES)
      .optional()
      .describe("The command to execute. Required unless cache_id is provided."),
    cache_id: z.string().optional().describe("Read a page from a previous paged command output without re-executing."),
    cwd: z.string().optional().describe("Working directory (optional)"),
    timeout: finiteInt(1, MAX_COMMAND_TIMEOUT_MS).optional().describe("Timeout in ms, default 30000"),
    page: z.number().int().min(1).optional().describe("Page number to read from paged output, default 1"),
    pageSize: z.number().int().min(1).max(10000).optional().describe("Characters per page, default 2000, max 10000"),
  });
  type ExecuteCommandInput = z.infer<typeof ExecuteCommandInput>;

  registerManagedTool(
    server,
    "execute_command",
    {
      title: "Execute Terminal Command",
      description: "Execute a single shell/terminal command. Returns structured result with exit code and stderr.",
      inputSchema: ExecuteCommandInput,
      outputSchema: withErrorSchema(commandOutputSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    wrapHandler(
      "execute_command",
      async ({ command, cache_id, cwd, timeout, page, pageSize }: ExecuteCommandInput, context: RequestContext) => {
        const t0 = Date.now();
        const boundedReject = validateBoundedCommandInput({ command, timeout });
        if (boundedReject) {
          return fail(ErrorCode.VALIDATION_ERROR, boundedReject, { retryable: false, param: "timeout|command" });
        }
        const hasCommand = command !== undefined;
        const hasCache = cache_id !== undefined;
        if (hasCommand === hasCache) {
          return fail(ErrorCode.VALIDATION_ERROR, "Provide exactly one of command or cache_id", {
            retryable: true,
            param: hasCommand ? "cache_id" : "command",
          });
        }
        if (hasCache && (cwd !== undefined || timeout !== undefined)) {
          return fail(ErrorCode.VALIDATION_ERROR, "cache_id mode does not accept command, cwd, or timeout", {
            retryable: true,
            param: cwd !== undefined ? "cwd" : "timeout",
          });
        }
        if (hasCommand && page !== undefined) {
          return fail(ErrorCode.VALIDATION_ERROR, "command mode does not accept page; use cache_id to read pages", {
            retryable: true,
            param: "page",
          });
        }

        if (hasCache) {
          try {
            const pageResult = await pageCache.read(cache_id, page ?? 1, pageSize);
            const envelope = buildCachedEnvelope(pageResult, Date.now() - t0);
            recordOutputRead(cache_id, pageResult.page, envelope);
            return success(pageResult.content, envelope, {
              latency_ms: Date.now() - t0,
              page: pageResult.page,
              total_pages: pageResult.total_pages,
            });
          } catch (error) {
            return cacheReadFailure(error, cache_id);
          }
        }

        const commandText = command as string;
        const dp = precheckCommand(commandText, "command");
        if (dp) return dp;
        const rateErr = checkRateLimit(commandRateLimit, "execute_command");
        if (rateErr) {
          return fail(ErrorCode.EXECUTION_FAILED, rateErr, {
            retryable: true,
            suggestion: "Wait ~100ms and retry (token bucket refills 10/s)",
          });
        }
        const { limits, reject: limitsReject } = resolveCommandLimits();
        if (limitsReject) return limitsReject;
        const block = await commandSafetyGate("execute_command", commandText, `执行命令: ${commandText}`, "command");
        if (block) return block;

        try {
          const { inv, effectiveCwd } = await prepareInvocation(commandText, cwd);
          const effectiveTimeout = timeout ?? adaptiveTimeout("execute_command");
          const result = await runCommandOutput(inv.file, inv.args, {
            timeout: effectiveTimeout,
            cwd: effectiveCwd,
            env: getSessionEnv(),
            limits,
            pageSize,
            signal: context.signal,
            requestId: context.requestId,
            scopeId: context.scopeId,
            kind: "execute-command",
          });
          session.pushHistory(commandText);
          const { capturedMs, error, ok, envelope } = finishCommandEnvelope(result, t0);

          audit.record({
            action: "command.execute",
            tool: "execute_command",
            detail: {
              command: commandText,
              cwd: effectiveCwd,
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              cancelled: result.cancelled,
              truncated: result.truncated || result.stderrTruncated,
              paged: result.paged,
              cacheId: result.cache?.id,
              latency_ms: capturedMs,
            },
            success: ok,
            error: error?.message,
          });

          let content = result.stdout || "(no output)";
          if (result.secretDetected) {
            content = "Command output suppressed because a secret pattern was detected";
          } else if (result.stderr) {
            content += `\n[stderr]:\n${result.stderr.slice(0, 500)}`;
          }
          if (!ok) {
            const code = error?.code ?? ErrorCode.EXECUTION_FAILED;
            return fail(code, error?.message ?? "Command failed", {
              retryable: error?.retryable,
              param: error?.param,
              suggestion: error?.suggestion,
              detail: error?.detail,
              structured: envelope as unknown as Record<string, unknown>,
            });
          }
          return success(content, envelope, {
            latency_ms: capturedMs,
            page: envelope.page,
            total_pages: envelope.total_pages,
          });
        } catch (error) {
          const supervisorFailure = processSupervisorFailure(error);
          if (supervisorFailure) return supervisorFailure;
          const msg = errMsg(error) || "Unknown error";
          recordCommandAudit("execute_command", commandText, { cwd: cwd || session.getCwd() }, false, msg);
          return shellResolutionFail(error) ?? fail(ErrorCode.EXECUTION_FAILED, msg, { retryable: true });
        }
      },
    ),
  );

  // ====================================================================
  const BatchExecuteInput = z.object({
    commands: boundedArray(boundedString(MAX_COMMAND_CHARS, MAX_COMMAND_BYTES), MAX_BATCH_ITEMS).describe(
      "Array of commands to execute",
    ),
    cwd: z.string().optional().describe("Working directory"),
    stop_on_error: z.boolean().optional().describe("Stop if a command fails, default true"),
    parallel: z.boolean().optional().describe("Execute commands in parallel (no dependencies), default false"),
  });
  type BatchExecuteInput = z.infer<typeof BatchExecuteInput>;

  registerManagedTool(
    server,
    "batch_execute",
    {
      title: "Batch Execute Commands",
      description: "Execute multiple commands sequentially. Stops on first error if stop_on_error is true (default).",
      inputSchema: BatchExecuteInput,
      outputSchema: withErrorSchema(
        z.object({
          results: z.array(completedBatchSchema.or(skippedBatchSchema)),
          all_ok: z.boolean(),
          completed: z.number(),
          failed: z.number(),
          skipped: z.number(),
          summary: z.string(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler(
      "batch_execute",
      async ({ commands, cwd, stop_on_error, parallel }: BatchExecuteInput, context: RequestContext) => {
        const t0 = Date.now();
        const boundedReject = validateBoundedCommandInput({ commands });
        if (boundedReject) {
          return fail(ErrorCode.VALIDATION_ERROR, boundedReject, { retryable: false, param: "commands" });
        }
        const stop = stop_on_error !== false;
        const isParallel = parallel === true;

        if (commands.length === 0) {
          const summary = "All 0 commands OK";
          return success(
            summary,
            { results: [], all_ok: true, completed: 0, failed: 0, skipped: 0, summary },
            { latency_ms: Date.now() - t0 },
          );
        }

        for (const cmd of commands) {
          const blocked = precheckCommand(cmd, "commands");
          if (blocked) return blocked;
        }

        const totalInputBytes = commands.reduce((sum, cmd) => sum + commandInputBytes(cmd), 0);
        if (totalInputBytes > MAX_BATCH_INPUT_BYTES) {
          return fail(
            ErrorCode.RESOURCE_LIMIT,
            `Batch input budget exceeded: ${totalInputBytes} bytes > ${MAX_BATCH_INPUT_BYTES}`,
            {
              retryable: true,
              suggestion: "Split the batch into smaller groups",
              detail: { limit: MAX_BATCH_INPUT_BYTES, total: totalInputBytes, commands: commands.length },
            },
          );
        }

        const block = await commandSafetyGate("batch_execute", "", `批量执行 ${commands.length} 条命令`, "commands", {
          batchCommands: commands,
        });
        if (block) return block;

        // 默认整批 1 token；MCP_BATCH_RATE_MODE=per_command 时按条消费
        const batchMode = getBatchRateMode();
        if (batchMode === "per_command") {
          for (let i = 0; i < commands.length; i++) {
            const rateErr = checkRateLimit(commandRateLimit, "batch_execute");
            if (rateErr) {
              return fail(ErrorCode.EXECUTION_FAILED, rateErr, {
                retryable: true,
                suggestion: "Wait ~100ms and retry (token bucket refills 10/s); or set MCP_BATCH_RATE_MODE=batch",
                detail: { batch_rate_mode: batchMode, consumed: i, total: commands.length },
              });
            }
          }
        } else {
          const rateErr = checkRateLimit(commandRateLimit, "batch_execute");
          if (rateErr) {
            return fail(ErrorCode.EXECUTION_FAILED, rateErr, {
              retryable: true,
              suggestion: "Wait ~100ms and retry (token bucket refills 10/s)",
              detail: { batch_rate_mode: batchMode },
            });
          }
        }

        const { limits, reject: limitsReject } = resolveCommandLimits("commands");
        if (limitsReject) return limitsReject;

        const budget = buildBatchBudget(context.signal);
        try {
          const shellSpec = await getShellSpec();
          const slots: Array<BatchCommandResult | undefined> = Array.from({ length: commands.length });
          let nextIndex = 0;
          let stopScheduling = false;
          let outputExhausted = false;

          const execOne = async (index: number): Promise<BatchCommandResult> => {
            const commandText = commands[index];
            if (!budget.reserve("input", commandInputBytes(commandText))) {
              return { index, command: commandText, status: "skipped", skip_reason: "budget_input" };
            }
            const ct0 = Date.now();
            try {
              logger.info("batch_execute", `step ${index + 1}/${commands.length}`, commandText);
              const inv = buildShellInvocation(commandText, shellSpec);
              const r = await runCommandOutput(inv.file, inv.args, {
                timeout: 30000,
                cwd: cwd || session.getCwd(),
                env: getSessionEnv(),
                limits,
                signal: context.signal,
                requestId: context.requestId,
                scopeId: context.scopeId,
                kind: "batch-command",
              });
              const latency = Date.now() - ct0;
              const error = commandError(r);
              const ok = error === undefined;
              const envelope = buildCommandEnvelope(r, latency, ok);
              if (error) envelope.error = error;
              audit.record({
                action: "command.execute",
                tool: "batch_execute",
                detail: {
                  command: commandText,
                  cwd: cwd || session.getCwd(),
                  exitCode: r.exitCode,
                  timedOut: r.timedOut,
                  cancelled: r.cancelled,
                  truncated: r.truncated || r.stderrTruncated,
                  paged: r.paged,
                },
                success: ok,
                error: error?.message,
              });
              return {
                index,
                command: commandText,
                status: "completed",
                latency_ms: latency,
                ...envelope,
              };
            } catch (error) {
              const latency = Date.now() - ct0;
              const structured: CommandOutputEnvelope = {
                ok: false,
                stdout: "",
                stderr: "",
                exit_code: null,
                timed_out: false,
                cancelled: false,
                truncated: false,
                stdout_truncated: false,
                stderr_truncated: false,
                paged: false,
                total_output_bytes: 0,
                retained_output_bytes: 0,
                stdout_total_bytes: 0,
                stdout_retained_bytes: 0,
                stderr_total_bytes: 0,
                stderr_retained_bytes: 0,
                total_chars: 0,
                stdout_encoding: "utf8",
                stderr_encoding: "utf8",
                captured_ms: latency,
                error: {
                  code: ErrorCode.EXECUTION_FAILED,
                  message: errMsg(error) || "Command failed",
                  retryable: true,
                },
              };
              return { index, command: commandText, status: "completed", latency_ms: latency, ...structured };
            }
          };

          const worker = async (): Promise<void> => {
            while (true) {
              if (stop && stopScheduling) return;
              if (outputExhausted) return;
              if (budget.abortSignal.aborted) return;
              const index = nextIndex++;
              if (index >= commands.length) return;
              const item = await execOne(index);
              slots[index] = item;
              if (stop && item.status === "completed" && !item.ok) stopScheduling = true;
              if (item.status === "completed" && !budget.reserve("output", item.total_output_bytes ?? 0)) {
                outputExhausted = true;
              }
            }
          };

          const concurrency = isParallel ? 4 : 1;
          await Promise.all(Array.from({ length: Math.min(concurrency, commands.length) }, () => worker()));
          const fillSkipReason = (): "budget_output" | "budget_deadline" | "stop_on_error" => {
            if (stopScheduling) return "stop_on_error";
            if (outputExhausted) return "budget_output";
            if (budget.abortSignal.aborted) return commandBudgetSkipReason(budget) ?? "stop_on_error";
            return "stop_on_error";
          };
          for (let index = 0; index < slots.length; index++) {
            if (!slots[index]) {
              slots[index] = { index, command: commands[index], status: "skipped", skip_reason: fillSkipReason() };
            }
          }
          const results = slots as BatchCommandResult[];
          const completed = results.filter((item) => item.status === "completed").length;
          const skipped = results.filter((item) => item.status === "skipped").length;
          const failed = results.filter((item) => item.status === "completed" && !item.ok).length;
          const allOk = failed === 0 && skipped === 0;
          const summary = allOk
            ? `All ${completed} commands OK`
            : `${completed} completed, ${failed} failed, ${skipped} skipped`;
          session.pushHistory(commands.join("; "));
          audit.record({
            action: "command.execute",
            tool: "batch_execute",
            detail: { commands, parallel: isParallel, completed, failed, skipped, allOk },
            success: allOk,
            error: allOk ? undefined : "Some commands failed or were skipped",
          });
          budget.close();
          return success(
            summary,
            { results, all_ok: allOk, completed, failed, skipped, summary },
            { latency_ms: Date.now() - t0 },
          );
        } catch (error) {
          budget.close();
          const supervisorFailure = processSupervisorFailure(error);
          if (supervisorFailure) return supervisorFailure;
          return (
            shellResolutionFail(error) ??
            fail(ErrorCode.EXECUTION_FAILED, errMsg(error) || "Batch failed", { retryable: true })
          );
        }
      },
    ),
  );

  // ====================================================================
  const WatchCommandInput = z.object({
    command: boundedString(MAX_COMMAND_CHARS, MAX_COMMAND_BYTES).describe("The command to run"),
    duration: finiteInt(1, MAX_WATCH_DURATION_MS).optional().describe("Max duration in ms, default 5000"),
    cwd: z.string().optional().describe("Working directory"),
  });
  type WatchCommandInput = z.infer<typeof WatchCommandInput>;

  registerManagedTool(
    server,
    "watch_command",
    {
      title: "Watch Command Output",
      description: "Execute a command and capture output for a limited duration. Useful for real-time monitoring.",
      inputSchema: WatchCommandInput,
      outputSchema: withErrorSchema(commandOutputSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("watch_command", async ({ command, duration, cwd }: WatchCommandInput, context: RequestContext) => {
      const t0 = Date.now();
      const boundedReject = validateBoundedCommandInput({ command, duration });
      if (boundedReject) {
        return fail(ErrorCode.VALIDATION_ERROR, boundedReject, { retryable: false, param: "duration|command" });
      }
      const blocked = precheckCommand(command, "command");
      if (blocked) return blocked;

      const { limits, reject: limitsReject } = resolveCommandLimits();
      if (limitsReject) return limitsReject;

      const block = await commandSafetyGate("watch_command", command, `监控命令: ${command}`, "command", {
        durationMs: duration ?? 5000,
      });
      if (block) return block;

      try {
        const { inv, effectiveCwd } = await prepareInvocation(command, cwd);
        const effectiveDuration = duration ?? 5000;
        const result = await runCommandOutput(inv.file, inv.args, {
          timeout: effectiveDuration,
          timeoutMode: "watch_window",
          cwd: effectiveCwd,
          env: getSessionEnv(),
          limits,
          signal: context.signal,
          requestId: context.requestId,
          scopeId: context.scopeId,
          kind: "watch-command",
        });
        const { capturedMs, error, ok, envelope } = finishCommandEnvelope(result, t0, "Watch command");
        audit.record({
          action: "command.execute",
          tool: "watch_command",
          detail: {
            command,
            cwd: effectiveCwd,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            captureLimitReached: result.captureLimitReached,
            terminationFailed: result.terminationFailed,
            truncated: result.truncated || result.stderrTruncated,
            paged: result.paged,
            cacheId: result.cache?.id,
            latency_ms: capturedMs,
          },
          success: ok,
          error: error?.message,
        });

        let output = result.stdout || "(no output)";
        if (result.secretDetected) {
          output = "Command output suppressed because a secret pattern was detected";
        } else if (result.stderr) {
          output += `\n[stderr]:\n${result.stderr.slice(0, 500)}`;
        }
        if (!ok) {
          return fail(error?.code ?? ErrorCode.EXECUTION_FAILED, error?.message ?? "Watch command failed", {
            retryable: error?.retryable,
            param: error?.param,
            suggestion: error?.suggestion,
            detail: error?.detail,
            structured: envelope as unknown as Record<string, unknown>,
          });
        }
        return success(result.secretDetected ? output : `$ ${command}\n${output}`, envelope, {
          latency_ms: capturedMs,
          page: envelope.page,
          total_pages: envelope.total_pages,
        });
      } catch (e: unknown) {
        const supervisorFailure = processSupervisorFailure(e);
        if (supervisorFailure) return supervisorFailure;
        const msg = errMsg(e) || "Watch failed";
        recordCommandAudit("watch_command", command, {}, false, msg);
        return shellResolutionFail(e) ?? fail(ErrorCode.EXECUTION_FAILED, msg, { retryable: true });
      }
    }),
  );
}
