// src/utils.ts — 核心工具函数：命令执行、格式化
import { execFile } from "node:child_process";
import { buildShellInvocation, getShellSpec } from "./shell.js";
import { spawnStream } from "./stream.js";

/**
 * 安全执行 shell 命令（通过统一解析的 shell spec + spawnStream）
 * 用于需要 shell 特性（管道/重定向）的场景。
 * 语义：超时 reject Timeout；exit≠0 且无输出 reject；有输出则 resolve 并附 EXIT CODE 标记。
 */
export async function safeExec(
  cmd: string,
  timeout = 30000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const inv = buildShellInvocation(cmd, await getShellSpec());
  const r = await spawnStream(inv.file, inv.args, {
    timeout,
    cwd,
    env: { PYTHONIOENCODING: "utf-8" },
  });
  if (r.timedOut) {
    throw new Error(`Timeout (${timeout}ms)\n[CMD]: ${cmd}`);
  }
  if (r.exitCode !== 0) {
    if (!r.stdout && !r.stderr) {
      throw new Error(`Exit code ${r.exitCode}\n[CMD]: ${cmd}`);
    }
    return { stdout: r.stdout, stderr: r.stderr ? `${r.stderr}\n[EXIT CODE] ${r.exitCode}` : "" };
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * 安全执行命令 — 使用 execFile 避免 shell 注入（用于参数化命令）
 */
export function safeExecFile(
  file: string,
  args: string[],
  timeout = 30000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: cwd || undefined,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          reject(error);
        } else {
          resolve({
            stdout: (stdout || "").toString(),
            stderr: (stderr || "").toString(),
          });
        }
      },
    );
  });
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const sign = bytes < 0 ? -1 : 1;
  let i = 0;
  let size = Math.abs(bytes);
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${(sign < 0 ? "-" : "") + size.toFixed(2)} ${units[i]}`;
}
