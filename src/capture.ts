/**
 * 命令捕获原语 — child lifecycle、原始字节事件、backpressure、drain 与 actual 计数
 * 不感知 page/cache/envelope；retention、scanner gate、staging 由 command-output 编排层组合
 */
import { spawn } from "node:child_process";
import { logger } from "./logger.js";

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
  captureLimitReached: boolean;
  terminationFailed: boolean;
  /** spawn 错误信息（ENOENT 等 spawn 失败；消费方 throw/reject 的 fail-closed 错误） */
  error: Error | null;
  /** 各流实际收到的字节数（含 drain 丢弃部分） */
  stdoutActualBytes: number;
  stderrActualBytes: number;
}

/** 终止子进程：先 SIGTERM，2s 后 SIGKILL；仍未关闭时通知调用方。 */
function terminateChild(child: ReturnType<typeof spawn>, onFailed: () => void): void {
  try {
    child.kill("SIGTERM");
  } catch (err) {
    logger.debug("capture", "sigterm-failed", String(err));
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGKILL");
    } catch (err) {
      logger.debug("capture", "sigkill-failed", String(err));
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) onFailed();
    }, 500).unref();
  }, 2000).unref();
}

/**
 * spawn 子进程并流式捕获原始字节。
 * 始终读完两个流并计数（drain），不因输出量杀进程——只有 timeout 与 fail-closed 会终止子进程。
 */
export async function captureCommand(
  file: string,
  args: string[],
  opts?: {
    timeout?: number;
    timeoutMode?: "timeout" | "watch_window";
    cwd?: string;
    env?: Record<string, string>;
    onChunk?: CaptureChunkHandler;
  },
): Promise<CaptureResult> {
  const timeout = opts?.timeout ?? 30000;
  const timeoutMode = opts?.timeoutMode ?? "timeout";
  const onChunk = opts?.onChunk;

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(file, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutActualBytes = 0;
    let stderrActualBytes = 0;
    let timedOut = false;
    let captureLimitReached = false;
    let terminationFailed = false;
    const pending = new Set<Promise<void>>();

    const finish = (code: number | null, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut,
        captureLimitReached,
        terminationFailed,
        error,
        stdoutActualBytes,
        stderrActualBytes,
      });
    };

    const requestTermination = () => {
      terminateChild(child, () => {
        if (settled) return;
        terminationFailed = true;
        finish(null);
      });
    };

    const timer = setTimeout(() => {
      if (timeoutMode === "watch_window") captureLimitReached = true;
      else timedOut = true;
      requestTermination();
    }, timeout);

    const controls: CaptureControls = {
      resume: (stream) => {
        try {
          child[stream]?.resume();
        } catch (err) {
          logger.debug("capture", "resume-failed", String(err));
        }
      },
    };

    const settleWithError = (err: unknown) => {
      if (settled) return;
      clearTimeout(timer);
      const error = err instanceof Error ? err : new Error(String(err));
      terminateChild(child, () => undefined);
      finish(null, error);
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
      const processChunk = async (): Promise<void> => {
        try {
          await handleChunk(stream, chunk);
        } catch (err) {
          settleWithError(err);
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
      clearTimeout(timer);
      finish(null, err);
    });

    child.on("close", (code) => {
      const finishAfterPending = () => finish(code);
      if (pending.size === 0) finishAfterPending();
      else void Promise.allSettled([...pending]).then(finishAfterPending);
    });
  });
}
