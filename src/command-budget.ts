/**
 * batch_execute 的输入/输出/wall-time 预算常量与 parent BudgetAccount 构建。
 * 预算层位于 command policy 与 supervisor 之后，只做资源记账，不判断命令安全。
 */
import { BUDGET_KINDS, BudgetAccount, type BudgetLimits, type BudgetVector } from "./hardening-contract.js";

/** 单条命令的字符与 UTF-8 字节上限（三个命令工具共用）。 */
export const MAX_COMMAND_CHARS = 65536;
export const MAX_COMMAND_BYTES = 131072;
/** execute_command timeout 上限；默认 30s、adaptive 上限 120s，schema 只拒绝非有限与荒谬值。 */
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
/** watch_command duration 上限；默认 5s、heavy 确认线 60s。 */
export const MAX_WATCH_DURATION_MS = 600_000;
/** batch 命令条数与聚合输入字节上限。 */
export const MAX_BATCH_ITEMS = 100;
export const MAX_BATCH_INPUT_BYTES = 2_097_152;
/** batch 总 wall-time deadline；到点后 worker 停止调度并 truthful skipped。 */
export const MAX_BATCH_WALLTIME_MS = 600_000;
/** batch 聚合输出配额；耗尽后剩余命令 budget_output skipped。 */
export const MAX_BATCH_OUTPUT_BYTES = 104_857_600;

/** 计算命令字符串的 UTF-8 字节预算占用。 */
export function commandInputBytes(command: string): number {
  return Buffer.byteLength(command, "utf8");
}

/**
 * 构建 batch parent 预算；signal 链接 context cancellation（外部取消会联动 abort），
 * overrides 仅供测试注入小额度，生产路径必须使用默认常量。
 */
export function buildBatchBudget(
  signal?: AbortSignal,
  overrides?: { input?: number; output?: number; walltimeMs?: number },
): BudgetAccount {
  const max = Object.fromEntries(BUDGET_KINDS.map((kind) => [kind, 0])) as BudgetVector;
  max.input = overrides?.input ?? MAX_BATCH_INPUT_BYTES;
  max.output = overrides?.output ?? MAX_BATCH_OUTPUT_BYTES;
  const walltimeMs = overrides?.walltimeMs ?? MAX_BATCH_WALLTIME_MS;
  const limits: BudgetLimits = { deadlineAt: Date.now() + walltimeMs, max };
  return new BudgetAccount("batch", limits, signal);
}

/** 对 budget account 不可用的情况返回 deadline 分类；外部取消由 CANCELLED 路径处理，不在此重复归类。 */
export function commandBudgetSkipReason(account: BudgetAccount): "budget_deadline" | null {
  if (Date.now() >= account.deadlineAt) return "budget_deadline";
  return null;
}

/**
 * handler 层二次校验：schema 由 SDK 层消费，直调 handler 的调用方不经过 zod，
 * 因此三个命令工具在副作用前必须用同一组常量重验输入。返回错误消息或 null。
 */
export function validateBoundedCommandInput(input: {
  command?: unknown;
  timeout?: unknown;
  duration?: unknown;
  commands?: unknown;
}): string | null {
  if (input.command !== undefined) {
    if (
      typeof input.command !== "string" ||
      Array.from(input.command).length > MAX_COMMAND_CHARS ||
      commandInputBytes(input.command) > MAX_COMMAND_BYTES
    ) {
      return `command must be a string within ${MAX_COMMAND_CHARS} chars / ${MAX_COMMAND_BYTES} bytes`;
    }
  }
  if (input.timeout !== undefined) {
    const timeout = input.timeout as number;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_TIMEOUT_MS) {
      return `timeout must be a finite integer in [1, ${MAX_COMMAND_TIMEOUT_MS}]`;
    }
  }
  if (input.duration !== undefined) {
    const duration = input.duration as number;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_WATCH_DURATION_MS) {
      return `duration must be a finite integer in [1, ${MAX_WATCH_DURATION_MS}]`;
    }
  }
  if (input.commands !== undefined) {
    if (!Array.isArray(input.commands) || input.commands.length > MAX_BATCH_ITEMS) {
      return `commands must be an array of at most ${MAX_BATCH_ITEMS} items`;
    }
    for (const cmd of input.commands) {
      if (
        typeof cmd !== "string" ||
        Array.from(cmd).length > MAX_COMMAND_CHARS ||
        commandInputBytes(cmd) > MAX_COMMAND_BYTES
      ) {
        return `each command must be a string within ${MAX_COMMAND_CHARS} chars / ${MAX_COMMAND_BYTES} bytes`;
      }
    }
  }
  return null;
}
