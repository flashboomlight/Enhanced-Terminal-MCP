/**
 * Everything CLI (es.exe) 本地可选路径解析
 * Everything 不随 Enhanced Terminal MCP 分发：用户自行安装后，经显式环境变量或固定 state 目录提供。
 * 解析只校验路径存在且为普通文件（lstat，不跟随 symlink），不下载、不执行、不锁版本
 * （2026-08-30 issue everything-distribution-compliance：移除固定 SHA-256 与仓库 fixture）。
 */
import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { logger } from "./logger.js";
import { getStateDirSync } from "./state-dir.js";

export const ES_EXE_ENV = "ENHANCED_TERMINAL_ES_PATH";

export type EsExeSource = "explicit" | "state";
export type EsExeReason =
  | "explicit_path_missing"
  | "explicit_path_not_file"
  | "explicit_path_unreadable"
  | "state_path_missing"
  | "state_path_not_file"
  | "state_path_unreadable";

export interface EsExeDiagnostic {
  reason: EsExeReason;
  env_name: string;
  default_path: string;
  download_performed: false;
  source: EsExeSource;
  path: string;
}

export type EsExeResolution =
  | { available: true; source: EsExeSource; path: string }
  | { available: false; source: EsExeSource; diagnostic: EsExeDiagnostic };

let resolvedSuccess: { source: EsExeSource; path: string } | null = null;
let verifyPromise: Promise<EsExeResolution> | null = null;

function configuredPath(): string | null {
  const raw = process.env[ES_EXE_ENV]?.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(raw);
}

function defaultStatePath(): string {
  return join(getStateDirSync(), "tools", "es.exe");
}

function reasonFor(source: EsExeSource, suffix: "missing" | "not_file" | "unreadable"): EsExeReason {
  return `${source}_path_${suffix}` as EsExeReason;
}

function diagnostic(source: EsExeSource, path: string, reason: EsExeReason): EsExeDiagnostic {
  return {
    reason,
    env_name: ES_EXE_ENV,
    default_path: defaultStatePath(),
    download_performed: false,
    source,
    path,
  };
}

async function inspectCandidate(source: EsExeSource, path: string): Promise<EsExeResolution> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT" || code === "ENOTDIR" ? reasonFor(source, "missing") : reasonFor(source, "unreadable");
    logger.warn("es-integrity", reason, path);
    return { available: false, source, diagnostic: diagnostic(source, path, reason) };
  }
  if (!stat.isFile()) {
    const reason = reasonFor(source, "not_file");
    logger.warn("es-integrity", reason, path);
    return { available: false, source, diagnostic: diagnostic(source, path, reason) };
  }
  return { available: true, source, path };
}

/** 解析本地 Everything binary；不创建目录、不下载、不执行、仓库不分发 es.exe。 */
export async function resolveEsExe(): Promise<EsExeResolution> {
  if (verifyPromise) return verifyPromise;
  verifyPromise = (async () => {
    const explicit = configuredPath();
    const source: EsExeSource = explicit ? "explicit" : "state";
    const path = explicit ?? defaultStatePath();
    // 成功解析按 source+path 进程级缓存：env 变更自动失配重验；失败不缓存，下次调用重试
    if (resolvedSuccess && resolvedSuccess.source === source && resolvedSuccess.path === path) {
      return { available: true, source, path };
    }
    const result = await inspectCandidate(source, path);
    if (result.available) resolvedSuccess = { source, path };
    return result;
  })();
  try {
    return await verifyPromise;
  } finally {
    verifyPromise = null;
  }
}

/** 兼容旧消费者：成功返回已校验路径，不可用返回 null。 */
export async function ensureEsExeIntegrity(): Promise<string | null> {
  const result = await resolveEsExe();
  return result.available ? result.path : null;
}

/** 测试用：清除成功缓存与 in-flight 共享。 */
export function resetEsIntegrityCache(): void {
  resolvedSuccess = null;
  verifyPromise = null;
}
