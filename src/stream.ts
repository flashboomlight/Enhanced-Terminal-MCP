/**
 * 流式命令执行器 — spawn + 增量输出
 * 替代 exec 全量缓冲，大输出场景首字节延迟从 5s→50ms
 */
import { processSupervisor } from "./process-supervisor.js";
import { buildShellInvocation, getShellSpec } from "./shell.js";

export interface StreamResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  terminationFailed: boolean;
  truncated: boolean;
  /** 完整的 stdout（流式收集完毕后的结果） */
  all: string;
}

/**
 * spawn 方式执行命令，流式收集输出
 * 大输出（>1MB）场景下首字节延迟远低于 exec
 */
export async function spawnStream(
  command: string,
  args: string[],
  opts?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
    maxOutput?: number;
    signal?: AbortSignal;
    requestId?: string | number;
    scopeId?: string;
    kind?: string;
    tree?: boolean;
    windowsVerbatimArguments?: boolean;
  },
): Promise<StreamResult> {
  const timeout = opts?.timeout ?? 30000;
  const maxOut = opts?.maxOutput ?? 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    let killed = false;
    let cancelled = false;
    let terminationFailed = false;
    const managed = processSupervisor.spawnManaged(command, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      windowsVerbatimArguments: opts?.windowsVerbatimArguments,
      stdio: ["ignore", "pipe", "pipe"],
      kind: opts?.kind ?? "stream",
      requestId: opts?.requestId,
      scopeId: opts?.scopeId,
      tree: opts?.tree,
      timeoutMs: timeout,
      signal: opts?.signal,
      onTimeout: () => {
        killed = true;
      },
      onCancel: () => {
        cancelled = true;
      },
      onTerminationFailed: () => {
        terminationFailed = true;
      },
    });
    const child = managed.child;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const maxStderr = 1024 * 1024; // 1MB stderr cap
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const prevLen = stdoutLen;
      stdoutLen += chunk.length;
      if (prevLen >= maxOut) {
        if (!truncated) truncated = true;
        return;
      }
      if (stdoutLen > maxOut) {
        const slice = chunk.subarray(0, maxOut - prevLen);
        stdoutChunks.push(slice);
        if (!truncated) {
          truncated = true;
          void managed.terminate("output-limit");
        }
      } else {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen <= maxStderr) stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      void (async () => {
        if (managed.state.terminationRequested) {
          try {
            await managed.terminate(managed.state.reason ?? "internal-error");
          } catch {
            terminationFailed = true;
          }
        }
        if (settled) return;
        settled = true;
        const stdout = Buffer.concat(stdoutChunks).toString() + (truncated ? "\n... (TRUNCATED)" : "");
        const stderr = Buffer.concat(stderrChunks).toString();
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut: killed,
          cancelled,
          terminationFailed,
          truncated,
          all: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
        });
      })();
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
/**
 * 快速执行简单命令（echo、dir、ls 等轻量级）— 统一走 shell spec
 */
export async function quickExec(
  command: string,
  timeout = 5000,
  cwd?: string,
): Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }> {
  const inv = buildShellInvocation(command, await getShellSpec());
  const r = await spawnStream(inv.file, inv.args, {
    timeout,
    cwd,
    maxOutput: 1024 * 1024,
    kind: "quick-exec",
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
  });
  return { stdout: r.stdout, exitCode: r.exitCode, timedOut: r.timedOut };
}
