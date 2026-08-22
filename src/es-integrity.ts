/**
 * Everything CLI (es.exe) 完整性校验与本地可选路径解析
 * 生产路径只允许显式环境变量或固定 state 目录，不读取仓库 fixture
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { getStateDirSync } from "./state-dir.js";

/** Everything CLI 的固定 SHA-256（更新 binary 时必须同步改此常量与测试） */
export const ES_EXE_SHA256 = "5101b3a6d9542de378e077f4b8c66c4e608d3bff088092427749b65fbb18b342";
export const ES_EXE_ENV = "ENHANCED_TERMINAL_ES_PATH";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** 仓库开发/测试 fixture 路径，不作为生产 resolver 默认路径 */
export const ES_EXE_PATH = join(MODULE_DIR, "..", "es_tool", "es.exe");

export type EsExeSource = "explicit" | "state";
export type EsExeReason =
  | "explicit_path_missing"
  | "explicit_path_not_file"
  | "explicit_path_unreadable"
  | "explicit_hash_mismatch"
  | "state_path_missing"
  | "state_path_not_file"
  | "state_path_unreadable"
  | "state_hash_mismatch";

export interface EsExeDiagnostic {
  reason: EsExeReason;
  expected_sha256: string;
  env_name: string;
  default_path: string;
  download_performed: false;
  source: EsExeSource;
  path: string;
  actual_sha256?: string;
}

export type EsExeResolution =
  | { available: true; source: EsExeSource; path: string }
  | { available: false; source: EsExeSource; diagnostic: EsExeDiagnostic };

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

interface VerifiedCandidate {
  fingerprint: FileFingerprint;
  path: string;
}

let verifiedCandidate: VerifiedCandidate | null = null;
let verifyPromise: Promise<EsExeResolution> | null = null;

function configuredPath(): string | null {
  const raw = process.env[ES_EXE_ENV]?.trim();
  if (!raw) return null;
  return isAbsolute(raw) ? raw : resolve(raw);
}

function defaultStatePath(): string {
  return join(getStateDirSync(), "tools", "es.exe");
}

function fileFingerprint(stat: Awaited<ReturnType<typeof lstat>>): FileFingerprint {
  return {
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    dev: Number(stat.dev),
    ino: Number(stat.ino),
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.dev === right.dev && left.ino === right.ino;
}

function reasonFor(source: EsExeSource, suffix: "missing" | "not_file" | "unreadable"): EsExeReason {
  return `${source}_path_${suffix}` as EsExeReason;
}

function hashMismatchReason(source: EsExeSource): EsExeReason {
  return `${source}_hash_mismatch` as EsExeReason;
}

function diagnostic(source: EsExeSource, path: string, reason: EsExeReason, actual_sha256?: string): EsExeDiagnostic {
  return {
    reason,
    expected_sha256: ES_EXE_SHA256,
    env_name: ES_EXE_ENV,
    default_path: defaultStatePath(),
    download_performed: false,
    source,
    path,
    ...(actual_sha256 ? { actual_sha256 } : {}),
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

  const fingerprint = fileFingerprint(stat);
  if (verifiedCandidate?.path === path && sameFingerprint(verifiedCandidate.fingerprint, fingerprint)) {
    return { available: true, source, path };
  }

  let contents: Buffer;
  try {
    contents = await readFile(path);
  } catch (error) {
    const reason = reasonFor(source, "unreadable");
    logger.warn("es-integrity", reason, `${path}: ${String(error)}`);
    return { available: false, source, diagnostic: diagnostic(source, path, reason) };
  }
  const actualSha256 = createHash("sha256").update(contents).digest("hex");
  if (actualSha256 !== ES_EXE_SHA256) {
    const reason = hashMismatchReason(source);
    logger.error("es-integrity", reason, path);
    return { available: false, source, diagnostic: diagnostic(source, path, reason, actualSha256) };
  }

  verifiedCandidate = { path, fingerprint };
  return { available: true, source, path };
}

/** 解析并校验本地 Everything binary；不创建目录、不下载、不读取仓库 fixture。 */
export async function resolveEsExe(): Promise<EsExeResolution> {
  if (verifyPromise) return verifyPromise;
  verifyPromise = (async () => {
    const explicit = configuredPath();
    if (explicit) return inspectCandidate("explicit", explicit);
    const statePath = defaultStatePath();
    return inspectCandidate("state", statePath);
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

/** 测试用：清除成功 fingerprint 与 in-flight 缓存。 */
export function resetEsIntegrityCache(): void {
  verifiedCandidate = null;
  verifyPromise = null;
}
