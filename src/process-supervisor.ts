/**
 * 统一管理生产 child process 的登记、超时、取消、树终止和 shutdown drain。
 *
 * 该模块只负责生命周期，不决定命令是否安全，也不提供 OS sandbox。
 */
import { type ChildProcess, execFile, type SpawnOptions, spawn } from "node:child_process";
import type { ProcessSnapshot } from "./hardening-contract.js";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_MAX_ACTIVE_PROCESSES = 64;
const DEFAULT_GRACE_MS = 500;
const DEFAULT_FORCE_WAIT_MS = 1500;
const DEFAULT_CONTROL_TIMEOUT_MS = 2000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 3000;

export type ProcessTerminationReason = "timeout" | "cancelled" | "output-limit" | "shutdown" | "internal-error";

export interface ProcessTrackingOptions {
  kind?: string;
  requestId?: string | number;
  scopeId?: string;
  tree?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  internalControl?: boolean;
  onTimeout?: () => void;
  onCancel?: () => void;
  onTerminationFailed?: () => void;
}

export interface ManagedSpawnOptions extends Omit<SpawnOptions, "signal">, ProcessTrackingOptions {}

export interface ManagedProcessState {
  timedOut: boolean;
  cancelled: boolean;
  terminationRequested: boolean;
  terminationFailed: boolean;
  terminated: boolean;
  reason?: ProcessTerminationReason;
}

export interface ManagedProcessSnapshot extends ProcessSnapshot {
  kind: string;
  scopeId: string;
}

export interface ProcessTerminationResult {
  exited: boolean;
  forced: boolean;
  failed: boolean;
  reason: ProcessTerminationReason;
}

export interface ManagedProcess {
  readonly child: ChildProcess;
  readonly snapshot: ManagedProcessSnapshot;
  readonly state: Readonly<ManagedProcessState>;
  terminate(reason: ProcessTerminationReason): Promise<ProcessTerminationResult>;
  unregister(): void;
}

export interface ProcessSupervisorOptions {
  maxActiveProcesses?: number;
  graceMs?: number;
  forceWaitMs?: number;
  killTree?: (pid: number) => Promise<boolean>;
}

export interface ManagedExecFileOptions extends ProcessTrackingOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
}

export interface ManagedExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  terminationFailed: boolean;
}

type ExecFileLauncher = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: (error: Error | null, stdout: unknown, stderr: unknown) => void,
) => ChildProcess;

export class ProcessSupervisorError extends Error {
  readonly code: "RESOURCE_LIMIT" | "PROCESS_SUPERVISOR_UNAVAILABLE" | "ABORT_ERR";

  constructor(message: string, code: "RESOURCE_LIMIT" | "PROCESS_SUPERVISOR_UNAVAILABLE" | "ABORT_ERR") {
    super(message);
    this.name = "ProcessSupervisorError";
    this.code = code;
  }
}

export class ManagedProcessError extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly terminationFailed: boolean;

  constructor(message: string, result: ManagedExecFileResult) {
    const parts = [message];
    if (result.stdout) parts.push(`[stdout]\n${result.stdout}`);
    if (result.stderr) parts.push(`[stderr]\n${result.stderr}`);
    super(parts.join("\n"));
    this.name = "ManagedProcessError";
    this.stdout = result.stdout;
    this.stderr = result.stderr;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.timedOut = result.timedOut;
    this.cancelled = result.cancelled;
    this.terminationFailed = result.terminationFailed;
  }
}

interface Entry {
  child: ChildProcess;
  snapshot: ManagedProcessSnapshot;
  state: ManagedProcessState;
  options: ProcessTrackingOptions;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  abortListener: (() => void) | null;
  terminationPromise: Promise<ProcessTerminationResult> | null;
  closed: boolean;
}

function assertPositiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ProcessSupervisorError(`${name} must be an integer in [1, ${max}]`, "RESOURCE_LIMIT");
  }
}

function assertNonNegativeInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ProcessSupervisorError(`${name} must be an integer in [0, ${max}]`, "RESOURCE_LIMIT");
  }
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function safeCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Lifecycle callbacks cannot be allowed to break registry cleanup.
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!isAlive(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(!isAlive(child)), timeoutMs);
    timer.unref?.();
    child.once("close", () => finish(true));
    child.once("error", () => finish(!isAlive(child)));
  });
}

function waitBriefly(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

/** 绑定一次性 child 事件；测试替身只有 on 时仍保持可测试。 */
function listenOnce(child: ChildProcess, event: string, listener: (...args: unknown[]) => void): void {
  if (typeof child.once === "function") child.once(event, listener);
  else child.on(event, listener);
}

export class ProcessSupervisor {
  private readonly active = new Map<ChildProcess, Entry>();
  private readonly maxActiveProcesses: number;
  private readonly graceMs: number;
  private readonly forceWaitMs: number;
  private readonly killTreeImpl: (pid: number) => Promise<boolean>;
  private shuttingDown = false;
  private shutdownPromise: Promise<import("./hardening-contract.js").ShutdownReport> | null = null;
  /** truthful health：SIGKILL 后仍未退出的终止失败累计（health 聚合 degraded 信号） */
  private terminationFailureCount = 0;

  constructor(options: ProcessSupervisorOptions = {}) {
    this.maxActiveProcesses = options.maxActiveProcesses ?? DEFAULT_MAX_ACTIVE_PROCESSES;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.forceWaitMs = options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS;
    assertPositiveInteger(this.maxActiveProcesses, "maxActiveProcesses", 1024);
    assertNonNegativeInteger(this.graceMs, "graceMs", 5000);
    assertPositiveInteger(this.forceWaitMs, "forceWaitMs", 10000);
    this.killTreeImpl = options.killTree ?? ((pid) => this.killWindowsTree(pid));
  }

  /** 返回当前活跃 child 数量和配置上限。 */
  get activeCount(): number {
    return this.active.size;
  }

  /** 终止失败累计（force kill 后仍未退出）；>0 表示曾有 child 无法保证被清理 */
  getTerminationFailureCount(): number {
    return this.terminationFailureCount;
  }

  /** 返回当前 supervisor 的活跃快照，按启动时间和 PID 稳定排序。 */
  getActiveSnapshots(): ManagedProcessSnapshot[] {
    return Array.from(this.active.values())
      .map((entry) => ({ ...entry.snapshot }))
      .sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
  }

  /** 在 child 创建前检查 shutdown 和 active process 上限。 */
  assertCanStart(internalControl = false): void {
    if (this.shuttingDown && !internalControl) {
      throw new ProcessSupervisorError("Process supervisor is draining", "PROCESS_SUPERVISOR_UNAVAILABLE");
    }
    if (!internalControl && this.active.size >= this.maxActiveProcesses) {
      throw new ProcessSupervisorError(`Active process limit reached: ${this.maxActiveProcesses}`, "RESOURCE_LIMIT");
    }
  }

  /** 创建并登记 managed child；Unix 默认创建独立 process group。 */
  spawnManaged(file: string, args: string[], options: ManagedSpawnOptions = {}): ManagedProcess {
    const {
      kind,
      requestId,
      scopeId,
      tree,
      timeoutMs,
      signal,
      internalControl,
      onTimeout,
      onCancel,
      onTerminationFailed,
      ...spawnOptions
    } = options;
    if (signal?.aborted) throw new ProcessSupervisorError("Operation cancelled before spawn", "ABORT_ERR");
    this.assertCanStart(internalControl === true);
    const child = spawn(file, args, {
      ...spawnOptions,
      detached: spawnOptions.detached ?? (tree !== false && !IS_WINDOWS),
      windowsHide: spawnOptions.windowsHide ?? IS_WINDOWS,
    });
    try {
      return this.track(child, {
        kind,
        requestId,
        scopeId,
        tree,
        timeoutMs,
        signal,
        internalControl,
        onTimeout,
        onCancel,
        onTerminationFailed,
      });
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have failed before a kill signal was possible.
      }
      throw error;
    }
  }

  /** 将已经由 execFile 创建的 child 加入 registry。 */
  track(child: ChildProcess, options: ProcessTrackingOptions = {}): ManagedProcess {
    this.assertCanStart(options.internalControl === true);
    const pid = Number.isSafeInteger(child.pid) && (child.pid as number) > 0 ? (child.pid as number) : 0;
    const tree = options.tree !== false;
    const snapshot: ManagedProcessSnapshot = {
      requestId: options.requestId ?? "direct-call",
      pid,
      startedAt: Date.now(),
      treeScope:
        pid === 0
          ? "pending"
          : tree
            ? IS_WINDOWS
              ? `windows-tree:${pid}`
              : `unix-process-group:${pid}`
            : `pid:${pid}`,
      kind: options.kind ?? "unknown",
      scopeId: options.scopeId ?? "direct-call",
    };
    const entry: Entry = {
      child,
      snapshot,
      state: {
        timedOut: false,
        cancelled: false,
        terminationRequested: false,
        terminationFailed: false,
        terminated: false,
      },
      options,
      timeoutTimer: null,
      abortListener: null,
      terminationPromise: null,
      closed: false,
    };
    if (this.active.size >= this.maxActiveProcesses && !options.internalControl) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort cleanup for a child created before capacity was observed.
      }
      throw new ProcessSupervisorError(`Active process limit reached: ${this.maxActiveProcesses}`, "RESOURCE_LIMIT");
    }
    this.active.set(child, entry);
    const cleanup = (): void => this.scheduleEntryRemoval(entry);
    listenOnce(child, "close", cleanup);
    listenOnce(child, "error", cleanup);
    listenOnce(child, "spawn", () => {
      const spawnedPid = child.pid;
      if (!Number.isSafeInteger(spawnedPid) || (spawnedPid as number) < 1) return;
      snapshot.pid = spawnedPid as number;
      snapshot.treeScope = tree
        ? IS_WINDOWS
          ? `windows-tree:${spawnedPid}`
          : `unix-process-group:${spawnedPid}`
        : `pid:${spawnedPid}`;
    });

    if (options.timeoutMs !== undefined) {
      assertPositiveInteger(options.timeoutMs, "timeoutMs", 24 * 60 * 60 * 1000);
      const timer = setTimeout(() => {
        if (!this.active.has(child) || entry.state.terminationRequested) return;
        entry.state.timedOut = true;
        safeCallback(options.onTimeout);
        void this.terminate(child, "timeout");
      }, options.timeoutMs);
      timer.unref?.();
      entry.timeoutTimer = timer;
    }

    if (options.signal) {
      const abort = (): void => {
        if (!this.active.has(child) || entry.state.terminationRequested) return;
        entry.state.cancelled = true;
        safeCallback(options.onCancel);
        void this.terminate(child, "cancelled");
      };
      entry.abortListener = abort;
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }

    return {
      child,
      snapshot,
      state: entry.state,
      terminate: (reason) => this.terminate(child, reason),
      unregister: cleanup,
    };
  }

  /** 幂等移除 child，并清理 timer/listener。 */
  unregister(child: ChildProcess): void {
    const entry = this.active.get(child);
    if (!entry) return;
    this.scheduleEntryRemoval(entry);
  }

  /** 在自然 close 或 termination promise 完成后清理 registry entry。 */
  private scheduleEntryRemoval(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.state.terminationRequested && !isAlive(entry.child)) entry.state.terminated = true;
    if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
    if (entry.abortListener && entry.options.signal) {
      entry.options.signal.removeEventListener("abort", entry.abortListener);
    }
    // close 与 termination promise 的完成顺序不确定；child 已退出时必须立即可见地清空 registry，
    // promise 剩余部分只写 state 字段，不再阻塞清理。
    if (!isAlive(entry.child) || !entry.state.terminationRequested || !entry.terminationPromise) {
      this.removeEntry(entry);
      return;
    }
    void entry.terminationPromise.then(
      () => this.removeEntry(entry),
      () => this.removeEntry(entry),
    );
  }

  /** 删除 entry；只删除仍然指向同一 child 的当前记录。 */
  private removeEntry(entry: Entry): void {
    if (this.active.get(entry.child) !== entry) return;
    this.active.delete(entry.child);
  }

  /** 终止一个 managed child；同一个 child 的并发调用共享唯一 promise。 */
  terminate(
    target: ChildProcess | ManagedProcess,
    reason: ProcessTerminationReason,
  ): Promise<ProcessTerminationResult> {
    const child = "child" in target ? target.child : target;
    const entry = this.active.get(child);
    if (!entry) {
      return Promise.resolve({
        exited: !isAlive(child),
        forced: false,
        failed: isAlive(child),
        reason,
      });
    }
    if (entry.terminationPromise) return entry.terminationPromise;
    entry.state.terminationRequested = true;
    entry.state.reason = reason;
    entry.terminationPromise = this.terminateEntry(entry, reason);
    // termination 完成且 child 已退出时主动回收，覆盖 close 事件尚未发射的窗口。
    void entry.terminationPromise.then(
      () => {
        if (!isAlive(entry.child)) this.scheduleEntryRemoval(entry);
      },
      () => {
        if (!isAlive(entry.child)) this.scheduleEntryRemoval(entry);
      },
    );
    return entry.terminationPromise;
  }

  /** 等待当前 registry 清空或 deadline，并返回 truthful shutdown report。 */
  shutdown(deadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS): Promise<import("./hardening-contract.js").ShutdownReport> {
    if (this.shutdownPromise) return this.shutdownPromise;
    assertPositiveInteger(deadlineMs, "shutdown deadline", 60000);
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const entries = Array.from(this.active.values());
      await Promise.allSettled(entries.map((entry) => this.terminate(entry.child, "shutdown")));
      const deadline = Date.now() + deadlineMs;
      while (this.active.size > 0 && Date.now() < deadline) {
        await waitBriefly(25);
      }
      const remaining = this.getActiveSnapshots().map((snapshot) => ({
        requestId: snapshot.requestId,
        pid: snapshot.pid,
        startedAt: snapshot.startedAt,
        treeScope: snapshot.treeScope,
      }));
      return {
        clean: remaining.length === 0,
        remaining,
        deadlineExceeded: remaining.length > 0,
      };
    })();
    return this.shutdownPromise;
  }

  /** 终止单个 entry，先尝试 graceful，再在 bounded window 内强制终止。 */
  private async terminateEntry(entry: Entry, reason: ProcessTerminationReason): Promise<ProcessTerminationResult> {
    const child = entry.child;
    let forced = false;
    if (IS_WINDOWS && entry.snapshot.treeScope.startsWith("windows-tree:")) {
      const treeKilled = await this.killTreeImpl(entry.snapshot.pid);
      if (!treeKilled && isAlive(child)) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The close/error event below determines whether termination failed.
        }
      }
      forced = true;
    } else {
      this.sendUnixOrChildSignal(child, entry.snapshot, "SIGTERM");
    }

    if (await waitForExit(child, this.graceMs)) {
      entry.state.terminated = true;
      return { exited: true, forced, failed: false, reason };
    }

    forced = true;
    this.sendUnixOrChildSignal(child, entry.snapshot, "SIGKILL");
    if (!(await waitForExit(child, this.forceWaitMs))) {
      entry.state.terminationFailed = true;
      this.terminationFailureCount++;
      safeCallback(entry.options.onTerminationFailed);
      return { exited: false, forced: true, failed: true, reason };
    }
    entry.state.terminated = true;
    return { exited: true, forced, failed: false, reason };
  }

  /** 发送 PID/group 信号；Unix group 失败时回退到已登记 child。 */
  private sendUnixOrChildSignal(child: ChildProcess, snapshot: ManagedProcessSnapshot, signal: NodeJS.Signals): void {
    if (!IS_WINDOWS && snapshot.treeScope.startsWith("unix-process-group:")) {
      try {
        process.kill(-snapshot.pid, signal);
        return;
      } catch {
        // A group can disappear before the child close event; try the child itself.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The child may already be gone; waitForExit decides whether this is a failure.
    }
  }

  /** Windows tree termination control process；参数只来自 registry PID。 */
  private killWindowsTree(pid: number): Promise<boolean> {
    if (!IS_WINDOWS) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (success: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(success);
      };
      const timer = setTimeout(() => finish(false), DEFAULT_CONTROL_TIMEOUT_MS);
      timer.unref?.();
      let control: ChildProcess;
      try {
        control = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        this.track(control, {
          kind: "supervisor-control",
          scopeId: "supervisor",
          tree: false,
          timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
          internalControl: true,
        });
      } catch {
        finish(false);
        return;
      }
      control.once("close", (code) => finish(code === 0));
      control.once("error", () => finish(false));
    });
  }
}

export const processSupervisor = new ProcessSupervisor();

/** 创建统一的 abort error，供 execFile adapter 保留稳定错误语义。 */
export function createProcessAbortError(): ProcessSupervisorError {
  return new ProcessSupervisorError("Operation cancelled", "ABORT_ERR");
}

/** 通过 supervisor 执行 execFile，并把 child 的生命周期纳入 registry。 */
export function execFileManaged(
  file: string,
  args: string[],
  options: ManagedExecFileOptions = {},
): Promise<ManagedExecFileResult> {
  if (options.signal?.aborted) return Promise.reject(createProcessAbortError());
  const { cwd, env, maxBuffer, ...tracking } = options;
  return new Promise((resolve, reject) => {
    let managed: ManagedProcess | null = null;
    let child: ChildProcess | null = null;
    try {
      processSupervisor.assertCanStart(options.internalControl === true);
      const launchExecFile = execFile as unknown as ExecFileLauncher;
      child = launchExecFile(
        file,
        args,
        {
          cwd,
          env,
          maxBuffer: maxBuffer ?? 10 * 1024 * 1024,
          encoding: "utf8",
          windowsHide: true,
          detached: options.tree !== false && !IS_WINDOWS,
        },
        (error, stdout, stderr) => {
          const state = managed?.state;
          const result: ManagedExecFileResult = {
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode: child?.exitCode ?? null,
            signal: child?.signalCode ?? null,
            timedOut: state?.timedOut ?? false,
            cancelled: state?.cancelled ?? false,
            terminationFailed: state?.terminationFailed ?? false,
          };
          void (async () => {
            if (managed?.state.terminationRequested) {
              try {
                await managed.terminate(managed.state.reason ?? "internal-error");
              } catch {
                result.terminationFailed = true;
              }
            }
            if (error) reject(new ManagedProcessError(error.message, result));
            else resolve(result);
          })();
        },
      );
      managed = processSupervisor.track(child, tracking);
    } catch (error) {
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Best effort cleanup when tracking itself cannot be established.
        }
      }
      reject(error);
    }
  });
}
