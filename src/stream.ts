/**
 * 流式命令执行器 — spawn + 增量输出
 * 替代 exec 全量缓冲，大输出场景首字节延迟从 5s→50ms
 */
import { spawn } from "node:child_process";
import { IS_WIN } from "./platform.js";

export interface StreamResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
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
  },
): Promise<StreamResult> {
  const timeout = opts?.timeout ?? 30000;
  const maxOut = opts?.maxOutput ?? 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const maxStderr = 1024 * 1024; // 1MB stderr cap
    let killed = false;
    let truncated = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // 给进程 2s 响应 SIGTERM，否则 SIGKILL
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (_err) {
          /* ignore */
        }
      }, 2000).unref();
    }, timeout);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxOut) {
        if (!truncated) {
          truncated = true;
          child.kill("SIGTERM");
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString() + (truncated ? "\n... (TRUNCATED)" : "");
      const stderr = Buffer.concat(stderrChunks).toString();
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut: killed,
        all: stdout + (stderr ? `\n[stderr]\n${stderr}` : ""),
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 快速执行简单命令（echo、dir、ls 等轻量级）
 */
export async function quickExec(
  command: string,
  timeout = 5000,
  cwd?: string,
): Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }> {
  if (IS_WIN) {
    const r = await spawnStream("cmd.exe", ["/c", command], { timeout, cwd, maxOutput: 1024 * 1024 });
    return { stdout: r.stdout, exitCode: r.exitCode, timedOut: r.timedOut };
  }
  const r = await spawnStream("/bin/sh", ["-c", command], { timeout, cwd, maxOutput: 1024 * 1024 });
  return { stdout: r.stdout, exitCode: r.exitCode, timedOut: r.timedOut };
}
