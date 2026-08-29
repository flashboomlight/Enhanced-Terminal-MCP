// src/utils.ts — 核心工具函数：命令执行、格式化
import { parseStrictInteger } from "./hardening-contract.js";
import { execFileManaged } from "./process-supervisor.js";
import { buildShellInvocation, getShellSpec } from "./shell.js";
import { spawnStream } from "./stream.js";

/**
 * 读取数字型环境变量，统一解析 + 下限 + 默认值
 * 消除各模块重复的 parseInt(process.env.X || "default") 模式
 */
export function envInt(name: string, defaultVal: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  try {
    return parseStrictInteger(process.env[name], { name, defaultValue: defaultVal, min, max });
  } catch {
    return defaultVal;
  }
}

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
    kind: "shell-exec",
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
  });
  if (r.cancelled) {
    throw new Error("Operation cancelled");
  }
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

/** 安全执行命令：通过 execFileManaged 运行参数化命令。 */
export interface SafeExecFileOptions {
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  requestId?: string | number;
  scopeId?: string;
  kind?: string;
  tree?: boolean;
  maxBuffer?: number;
}

/** 执行参数化 child process，并将其生命周期交给 ProcessSupervisor。 */
export function safeExecFile(
  file: string,
  args: string[],
  timeoutOrOptions: number | SafeExecFileOptions = 30000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const config: SafeExecFileOptions =
    typeof timeoutOrOptions === "number" ? { timeout: timeoutOrOptions, cwd } : timeoutOrOptions;
  return execFileManaged(file, args, {
    timeoutMs: config.timeout ?? 30000,
    cwd: config.cwd,
    env: config.env,
    signal: config.signal,
    requestId: config.requestId,
    scopeId: config.scopeId,
    kind: config.kind ?? "exec-file",
    tree: config.tree,
    maxBuffer: config.maxBuffer ?? 10 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
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
