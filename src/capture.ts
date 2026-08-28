/**
 * 命令捕获原语 — child lifecycle、原始字节事件、backpressure、drain 与 actual 计数
 * 不感知 page/cache/envelope；retention、scanner gate、staging 由 command-output 编排层组合
 */
import { logger } from "./logger.js";
import { processSupervisor } from "./process-supervisor.js";

export type CaptureStreamName = "stdout" | "stderr";

/** backpressure 控制柄，作为第三个参数传给每个 chunk 回调 */
export interface CaptureControls {
  /** 恢复被暂停的流（幂等；若流已由 chunk 回调内联恢复则为空操作） */
  resume: (stream: CaptureStreamName) => void;
}

/**
 * 原始字节事件回调。按到达顺序逐 chunk 调用；消费方停止保留后仍会持续回调（drain）。
 * 返回 false（或 resolve false）→ capture 暂停该流，消费方之后用 controls.resume() 恢复；
 * 恢复可直接在回调内联调用，此时 capture 检测到流已恢复则跳过自身 resume。
 * 同步 throw 或 async reject → fail-closed：capture 终止子进程并以该错误 settle。
 * 返回类型为 unknown：只有 false 与 thenable 有运行时语义，其余返回值一律忽略（等同继续）。
 */
export type CaptureChunkHandler = (stream: CaptureStreamName, chunk: Buffer, controls: CaptureControls) => unknown;

export interface CaptureResult {
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  captureLimitReached: boolean;
  terminationFailed: boolean;
  /** spawn 错误信息（ENOENT 等 spawn 失败；消费方 throw/reject 的 fail-closed 错误） */
  error: Error | null;
  /** 各流实际收到的字节数（含 drain 丢弃部分） */
  stdoutActualBytes: number;
  stderrActualBytes: number;
}

/**
 * spawn 子进程并流式捕获原始字节。
 * timeout/cancel/tree termination 由 ProcessSupervisor 统一处理。
 */
export async function captureCommand(
  file: string,
  args: string[],
  opts?: {
    timeout?: number;
    timeoutMode?: "timeout" | "watch_window";
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    requestId?: string | number;
    scopeId?: string;
    kind?: string;
    tree?: boolean;
    maxPendingBytes?: number;
    onChunk?: CaptureChunkHandler;
  },
): Promise<CaptureResult> {
  const timeout = opts?.timeout ?? 30000;
  const timeoutMode = opts?.timeoutMode ?? "timeout";
  const onChunk = opts?.onChunk;
  const maxPendingBytes = opts?.maxPendingBytes ?? 4 * 1024 * 1024;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let captureLimitReached = false;
    let terminationFailed = false;
    let pendingBytes = 0;
    const pending = new Set<Promise<void>>();
    let managed: import("./process-supervisor.js").ManagedProcess | null = null;

    const finish = (code: number | null, error: Error | null = null): void => {
      if (settled) return;
      settled = true;
      resolve({
        exitCode: code,
        timedOut,
        cancelled,
        captureLimitReached,
        terminationFailed,
        error,
        stdoutActualBytes,
        stderrActualBytes,
      });
    };

    let stdoutActualBytes = 0;
    let stderrActualBytes = 0;
    if (opts?.signal?.aborted) {
      cancelled = true;
      finish(null);
      return;
    }
    try {
      managed = processSupervisor.spawnManaged(file, args, {
        cwd: opts?.cwd,
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        kind: opts?.kind ?? "capture",
        requestId: opts?.requestId,
        scopeId: opts?.scopeId,
        tree: opts?.tree,
        timeoutMs: timeout,
        signal: opts?.signal,
        onTimeout: () => {
          if (timeoutMode === "watch_window") captureLimitReached = true;
          else timedOut = true;
        },
        onCancel: () => {
          cancelled = true;
        },
        onTerminationFailed: () => {
          terminationFailed = true;
          finish(null);
        },
      });
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const child = managed.child;

    const controls: CaptureControls = {
      resume: (stream) => {
        try {
          child[stream]?.resume();
        } catch (err) {
          logger.debug("capture", "resume-failed", String(err));
        }
      },
    };

    const settleWithError = (err: unknown): void => {
      if (settled) return;
      void managed?.terminate("internal-error");
      finish(null, err instanceof Error ? err : new Error(String(err)));
    };

    const handleChunk = async (stream: CaptureStreamName, chunk: Buffer): Promise<void> => {
      if (settled || !onChunk) return;

      let decision: unknown;
      try {
        decision = onChunk(stream, chunk, controls);
      } catch (err) {
        settleWithError(err);
        return;
      }

      if (decision === false) {
        child[stream]?.pause();
      } else if (decision && typeof (decision as Promise<boolean | undefined>).then === "function") {
        child[stream]?.pause();
        try {
          const d = await (decision as Promise<boolean | undefined>);
          if (settled || d === false) return;
          const target = child[stream];
          if (target?.isPaused()) controls.resume(stream);
        } catch (err) {
          settleWithError(err);
        }
      }
    };

    const queues: Record<CaptureStreamName, Promise<void>> = {
      stdout: Promise.resolve(),
      stderr: Promise.resolve(),
    };
    const enqueueChunk = (stream: CaptureStreamName, chunk: Buffer): void => {
      if (settled) return;
      if (stream === "stdout") stdoutActualBytes += chunk.length;
      else stderrActualBytes += chunk.length;
      if (pendingBytes + chunk.length > maxPendingBytes) {
        captureLimitReached = true;
        child.stdout?.pause();
        child.stderr?.pause();
        void managed.terminate("output-limit");
        return;
      }
      pendingBytes += chunk.length;
      const processChunk = async (): Promise<void> => {
        try {
          await handleChunk(stream, chunk);
        } catch (err) {
          settleWithError(err);
        } finally {
          pendingBytes -= chunk.length;
        }
      };
      const task = queues[stream].then(processChunk, processChunk);
      queues[stream] = task;
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task),
      );
    };

    child.stdout?.on("data", (chunk: Buffer) => enqueueChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => enqueueChunk("stderr", chunk));

    child.on("error", (err) => {
      if (settled) return;
      finish(null, err);
    });

    child.on("close", (code) => {
      const finishAfterPending = async (): Promise<void> => {
        if (managed?.state.terminationRequested) {
          try {
            await managed.terminate(managed.state.reason ?? "internal-error");
          } catch (error) {
            terminationFailed = true;
            finish(null, error instanceof Error ? error : new Error(String(error)));
            return;
          }
        }
        finish(code);
      };
      if (pending.size === 0) void finishAfterPending();
      else void Promise.allSettled([...pending]).then(() => finishAfterPending());
    });
  });
}
