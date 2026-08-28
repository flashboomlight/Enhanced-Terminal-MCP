/**
 * 生产硬化共享契约：请求上下文、执行预算、严格输入校验和父子账本。
 *
 * 本模块只提供可复用的类型与局部状态基础，不直接执行命令、访问文件或决定具体工具策略。
 */
import * as z from "zod";

export type ExecutionProfile = "local-trusted-shell" | "sandboxed-production";

export type Capability =
  | "shell-execution"
  | "argv-execution"
  | "host-process-inspection"
  | "host-environment-read"
  | "network-egress"
  | "filesystem-write";

export type BudgetKind = "input" | "output" | "disk" | "queue" | "process" | "response";

export const BUDGET_KINDS: readonly BudgetKind[] = Object.freeze([
  "input",
  "output",
  "disk",
  "queue",
  "process",
  "response",
] as const);

export type BudgetScope = "request" | "batch" | "child" | "session";

export interface RequestHandlerExtraLike {
  signal: AbortSignal;
  requestId: string | number;
  sessionId?: string;
  authInfo?: unknown;
}

export interface RequestContext {
  requestId: string | number;
  scopeId: string;
  profile: ExecutionProfile;
  signal: AbortSignal;
  sessionId?: string;
  authInfo?: unknown;
}

export interface CapabilityDecision {
  allowed: boolean;
  code?: "CAPABILITY_DENIED" | "SANDBOX_UNAVAILABLE";
  reason?: string;
}

export interface CapabilityPolicy {
  check(context: RequestContext, capability: Capability): CapabilityDecision;
}

export interface InputBudget {
  maxStringChars: number;
  maxPathChars: number;
  maxUrlChars: number;
  maxRegexPatternChars: number;
  maxCommandChars: number;
  maxBatchCommands: number;
  maxBatchWallTimeMs: number;
  maxBatchOutputBytes: number;
  maxSearchResults: number;
  maxSearchDepth: number;
  maxDirectoryEntries: number;
  maxTraversalEntries: number;
  maxTreeEntries: number;
  maxTreeBytes: number;
  maxReadLines: number;
  maxFileBytes: number;
  maxResponseBytes: number;
  maxEnvEntries: number;
  maxEnvBytes: number;
  maxPendingCaptureBytes: number;
  maxDownloadBytes: number;
  maxArchiveMembers: number;
  maxArchiveMemberBytes: number;
  maxExpandedArchiveBytes: number;
}

export interface ExecutionLimits {
  maxCommandChars: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  maxTotalOutputBytes: number;
  maxPendingCaptureBytes: number;
  maxResponseBytes: number;
  maxWallTimeMs: number;
  maxActiveProcesses: number;
  maxDescendantProcesses: number;
  maxDiskBytes: number;
}

export type BudgetVector = Record<BudgetKind, number>;

export interface BudgetLimits {
  max: BudgetVector;
  deadlineAt: number;
}

export interface ExecutionRequest {
  context: RequestContext;
  profile: ExecutionProfile;
  backend: "shell" | "argv";
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  limits: ExecutionLimits;
  budget: BudgetAccount;
  metadata: {
    tool: string;
    commandHash: string;
    destructive: boolean;
  };
}

export interface ExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputLimitReached: boolean;
  terminationFailed: boolean;
  stdoutActualBytes: number;
  stderrActualBytes: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcessSnapshot {
  requestId: string | number;
  pid: number;
  startedAt: number;
  treeScope: string;
}

export interface ExecutionHandle {
  readonly requestId: string | number;
  readonly pid: number;
  readonly startedAt: number;
  readonly treeScope: string;
  wait(): Promise<ExecutionResult>;
  cancel(): Promise<void>;
}

export interface ShutdownReport {
  clean: boolean;
  remaining: ProcessSnapshot[];
  deadlineExceeded: boolean;
}

export interface ExecutionBackend {
  readonly profile: ExecutionProfile;
  readonly capabilities: ReadonlySet<Capability>;
  start(request: ExecutionRequest): Promise<ExecutionHandle>;
}

export interface ValidationFailure {
  code: "VALIDATION_ERROR" | "RESOURCE_LIMIT";
  param: string;
  message: string;
  retryable: boolean;
  detail?: Record<string, unknown>;
}

export interface StrictIntegerOptions {
  name?: string;
  defaultValue?: number;
  min: number;
  max: number;
}

export class HardeningConfigError extends Error {
  readonly code = "CONFIG_INVALID" as const;
  readonly param: string;

  constructor(message: string, param = "config") {
    super(message);
    this.name = "HardeningConfigError";
    this.param = param;
  }
}

function assertFiniteRange(min: number, max: number): void {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new RangeError(`Invalid numeric range: ${min}..${max}`);
  }
}

function assertSafeBudgetValue(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function createZeroVector(): BudgetVector {
  return {
    input: 0,
    output: 0,
    disk: 0,
    queue: 0,
    process: 0,
    response: 0,
  };
}

function cloneVector(vector: BudgetVector): BudgetVector {
  return { ...vector };
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface BudgetState {
  max: BudgetVector;
  used: BudgetVector;
  deadlineAt: number;
  controller: AbortController;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  signalCleanup: (() => void) | null;
  closed: boolean;
}

/**
 * 共享父子资源账本。
 *
 * reserve 是同步的，确保 Node async 调度下不会在一次扣减中被插入其它任务；
 * child 共享同一个 state，因此不会意外获得一份新的完整额度。
 */
export class BudgetAccount {
  private readonly state: BudgetState;
  private readonly owner: boolean;
  private closed = false;

  readonly scope: BudgetScope;
  readonly abortSignal: AbortSignal;
  readonly deadlineAt: number;

  constructor(scope: BudgetScope, limits: BudgetLimits, signal?: AbortSignal) {
    this.scope = scope;
    this.state = createBudgetState(limits, signal);
    this.owner = true;
    this.abortSignal = this.state.controller.signal;
    this.deadlineAt = this.state.deadlineAt;
  }

  /**
   * 预留资源；非法数量、已关闭、已取消、已过期或超 parent 余额时返回 false。
   */
  reserve(kind: BudgetKind, amount: number): boolean {
    if (!BUDGET_KINDS.includes(kind) || !Number.isSafeInteger(amount) || amount < 0) return false;
    if (!this.isAvailable()) return false;
    if (amount === 0) return true;

    const next = this.state.used[kind] + amount;
    if (next > this.state.max[kind]) return false;
    this.state.used[kind] = next;
    return true;
  }

  /**
   * 返回当前 parent ledger 的剩余额度；不可用账本统一返回 0。
   */
  remaining(kind: BudgetKind): number {
    if (!BUDGET_KINDS.includes(kind) || !this.isAvailable()) return 0;
    return Math.max(0, this.state.max[kind] - this.state.used[kind]);
  }

  /**
   * 创建共享 parent ledger 的 child view，不复制额度。
   */
  child(scope: Exclude<BudgetScope, "request" | "session">): BudgetAccount {
    return BudgetAccount.fromState(scope, this.state, this.closed);
  }

  /**
   * 关闭当前 view；root close 会取消整个 ledger，child close 不影响兄弟或 parent。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.owner) return;

    this.state.closed = true;
    this.state.controller.abort();
    this.state.signalCleanup?.();
    this.state.signalCleanup = null;
    if (this.state.deadlineTimer) {
      clearTimeout(this.state.deadlineTimer);
      this.state.deadlineTimer = null;
    }
  }

  private static fromState(scope: BudgetScope, state: BudgetState, closed: boolean): BudgetAccount {
    const account = Object.create(BudgetAccount.prototype) as BudgetAccount;
    Object.defineProperties(account, {
      state: { value: state },
      owner: { value: false },
      closed: { value: closed, writable: true },
      scope: { value: scope },
      abortSignal: { value: state.controller.signal },
      deadlineAt: { value: state.deadlineAt },
    });
    return account;
  }

  private isAvailable(): boolean {
    if (this.closed || this.state.closed || this.abortSignal.aborted) return false;
    if (Date.now() >= this.deadlineAt) {
      this.state.controller.abort();
      return false;
    }
    return true;
  }
}

function createBudgetState(limits: BudgetLimits, signal?: AbortSignal): BudgetState {
  if (!Number.isSafeInteger(limits.deadlineAt)) {
    throw new RangeError("deadlineAt must be a safe integer");
  }
  for (const kind of BUDGET_KINDS) {
    assertSafeBudgetValue(limits.max[kind], `max.${kind}`);
  }

  const controller = new AbortController();
  const state: BudgetState = {
    max: cloneVector(limits.max),
    used: createZeroVector(),
    deadlineAt: limits.deadlineAt,
    controller,
    deadlineTimer: null,
    signalCleanup: null,
    closed: false,
  };

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      state.signalCleanup = () => signal.removeEventListener("abort", onAbort);
    }
  }

  if (state.deadlineAt <= Date.now()) {
    state.controller.abort();
    return state;
  }

  armDeadlineTimer(state);
  return state;
}

/** 安排可跨越 Node 定时器最大延迟的 deadline；长 deadline 分段等待且不保持进程存活。 */
function armDeadlineTimer(state: BudgetState): void {
  const delay = Math.max(0, Math.min(state.deadlineAt - Date.now(), MAX_TIMER_DELAY_MS));
  state.deadlineTimer = setTimeout(() => {
    if (state.closed) return;
    if (Date.now() >= state.deadlineAt) {
      state.deadlineTimer = null;
      state.controller.abort();
      return;
    }
    state.deadlineTimer = null;
    armDeadlineTimer(state);
  }, delay);
  state.deadlineTimer.unref?.();
}

/**
 * 构造有限范围的 Zod number schema。
 */
export function finiteNumber(min: number, max: number): z.ZodNumber {
  assertFiniteRange(min, max);
  return z.number().finite().min(min).max(max);
}

/**
 * 构造有限整数 Zod schema。
 */
export function finiteInt(min: number, max: number): z.ZodNumber {
  assertFiniteRange(min, max);
  return z.number().finite().int().min(min).max(max);
}

/**
 * 同时按 Unicode code point 和 UTF-8 byte 限制字符串。
 */
export function boundedString(maxChars: number, maxBytes: number): z.ZodType<string> {
  assertSafeBudgetValue(maxChars, "maxChars");
  assertSafeBudgetValue(maxBytes, "maxBytes");
  return z
    .string()
    .refine((value) => Array.from(value).length <= maxChars, { message: "String exceeds character limit" })
    .refine((value) => Buffer.byteLength(value, "utf8") <= maxBytes, { message: "String exceeds byte limit" });
}

/**
 * 限制数组数量并复用调用方提供的 item schema。
 */
export function boundedArray<T extends z.ZodTypeAny>(item: T, maxItems: number): z.ZodArray<T> {
  assertSafeBudgetValue(maxItems, "maxItems");
  return z.array(item).max(maxItems);
}

/**
 * 严格读取十进制非负整数配置，拒绝 parseInt 前缀、科学计数法和溢出。
 */
export function parseStrictInteger(raw: string | undefined, options: StrictIntegerOptions): number {
  const name = options.name ?? "config";
  assertFiniteRange(options.min, options.max);
  if (!Number.isSafeInteger(options.min) || !Number.isSafeInteger(options.max)) {
    throw new RangeError(`${name} range must use safe integers`);
  }

  if (raw === undefined || raw.trim() === "") {
    if (options.defaultValue !== undefined) {
      if (
        !Number.isSafeInteger(options.defaultValue) ||
        options.defaultValue < options.min ||
        options.defaultValue > options.max
      ) {
        throw new RangeError(`${name} default is outside its range`);
      }
      return options.defaultValue;
    }
    throw new HardeningConfigError(`${name} is required`, name);
  }

  const valueText = raw.trim();
  if (!/^\d+$/.test(valueText)) {
    throw new HardeningConfigError(`${name} must be a decimal integer`, name);
  }
  const value = Number(valueText);
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new HardeningConfigError(`${name} is outside the allowed range`, name);
  }
  return value;
}
