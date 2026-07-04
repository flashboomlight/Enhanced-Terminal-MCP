/**
 * 状态目录管理
 * 解析状态文件存放位置，支持环境变量覆盖，自动创建目录
 */

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const DEFAULT_STATE_DIR_NAME = ".enhanced-terminal-mcp";

function resolveStateDir(): string {
  if (process.env.MCP_STATE_DIR) {
    return resolve(process.env.MCP_STATE_DIR);
  }
  return resolve(PROJECT_ROOT, DEFAULT_STATE_DIR_NAME);
}

let cachedStateDir: string | null = null;

/** 重置状态目录缓存（测试用） */
export function resetStateDirCache(): void {
  cachedStateDir = null;
}

/**
 * 获取状态目录绝对路径。
 * 首次调用时若目录不存在会自动创建。
 */
export async function getStateDir(): Promise<string> {
  if (cachedStateDir) return cachedStateDir;
  const dir = resolveStateDir();
  try {
    await fs.mkdir(dir, { recursive: true });
    cachedStateDir = dir;
    return dir;
  } catch (e) {
    logger.warn("state-dir", "mkdir-failed", `${dir}: ${String(e)}`);
    throw new Error(`Failed to create state directory: ${dir}`);
  }
}

/**
 * 同步获取状态目录绝对路径（不自动创建目录，用于已知目录已存在场景）
 */
export function getStateDirSync(): string {
  if (cachedStateDir) return cachedStateDir;
  return resolveStateDir();
}

/**
 * 会话状态文件路径
 */
export async function getStateFilePath(): Promise<string> {
  const dir = await getStateDir();
  return join(dir, "session.json");
}

/**
 * 旧的会话状态文件路径（系统临时目录）
 */
export function getLegacyStateFilePath(): string {
  return join(tmpdir(), ".enhanced-terminal-mcp-session.json");
}
