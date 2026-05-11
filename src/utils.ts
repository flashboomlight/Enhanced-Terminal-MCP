// src/utils.ts — 核心工具函数：命令执行、格式化、响应构建
import { exec, execFile } from "child_process";
import { getShell, wrapCommand } from "./platform.js";

/**
 * 安全执行 shell 命令（通过 shell 解释器）
 * 适用于需要管道、重定向等 shell 特性的命令
 */
export function safeExec(
  cmd: string,
  timeout = 30000,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const fullCmd = wrapCommand(cmd);
    const proc = exec(fullCmd, {
      cwd: cwd || undefined,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      timeout: timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: getShell(),
      encoding: "buffer",
    } as any, (error: any, stdoutBuf: any, stderrBuf: any) => {
      const stdout = smartDecode(stdoutBuf);
      const stderr = smartDecode(stderrBuf);
      if (error) {
        if (error.killed) {
          reject(new Error(`Timeout (${timeout}ms)\n[CMD]: ${cmd}`));
        } else if (!stdout && !stderr) {
          reject(new Error(`Exit code ${error.code}\n[CMD]: ${cmd}\n[DETAIL]: ${error.message}`));
        } else {
          resolve({ stdout, stderr: stderr ? stderr + "\n[EXIT CODE] " + error.code : "" });
        }
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * 安全执行命令 — 使用 execFile 避免 shell 注入（用于参数化命令）
 */
export function safeExecFile(
  file: string,
  args: string[],
  timeout = 30000,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: cwd || undefined,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        reject(error);
      } else {
        resolve({
          stdout: (stdout || "").toString(),
          stderr: (stderr || "").toString(),
        });
      }
    });
  });
}

/**
 * 智能编码解码：优先 UTF-8，乱码回退 GBK
 */
function smartDecode(buf: Buffer | null): string {
  if (!buf || buf.length === 0) return "";
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("\ufffd")) return utf8;
  try {
    return new TextDecoder("gbk", { fatal: false }).decode(buf);
  } catch {
    return utf8;
  }
}

/**
 * 格式化文件大小
 */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(2) + " " + units[i];
}

/**
 * 成功响应（纯文本）
 */
export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * 错误响应（带 isError 标记）
 */
export function fail(text: string) {
  return { content: [{ type: "text" as const, text: "[ERROR] " + text }], isError: true as const };
}

/**
 * 成功响应（结构化输出：同时包含 content 文本和 structuredContent JSON）
 */
export function okStructured(text: string, data: Record<string, any>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data,
  };
}
