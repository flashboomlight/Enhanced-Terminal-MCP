/**
 * 状态目录管理（merge-e-hardening 4.5 协议）
 *
 * - projectRoot 固定为启动时 realpath(process.cwd())，进程生命周期内不变，
 *   不随 session cwd / 单条命令 cwd 漂移；
 * - 默认状态目录 <projectRoot>/.etmcp；MCP_STATE_DIR 覆盖时相对路径只相对
 *   固定 projectRoot 解析一次，且设置后不执行旧目录自动迁移；
 * - 旧目录 <projectRoot>/.enhanced-terminal-mcp 中仅 session.json 与
 *   logs/audit.jsonl 参与事务化迁移：排他锁、不跟随 symlink/junction、
 *   源指纹监控、同卷 staging + 原子替换 + 回读验证；
 * - 迁移任一步失败抛出带 STATE_MIGRATION_FAILED 标识的错误，源与已有目标保持不变。
 */

import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { logger } from "./logger.js";

/** 进程级固定 projectRoot：启动时计算一次，之后绝不变化 */
const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
})();

const DEFAULT_STATE_DIR_NAME = ".etmcp";
const LEGACY_STATE_DIR_NAME = ".enhanced-terminal-mcp";
const LOCK_FILE_NAME = ".migration.lock";
const LOCK_RETRY_COUNT = 50;
const LOCK_RETRY_INTERVAL_MS = 100;

/** 迁移失败标识：启动流程见到此标识必须停止启动 */
export const STATE_MIGRATION_FAILED = "STATE_MIGRATION_FAILED";

function migrationError(message: string): Error {
  const err = new Error(`${STATE_MIGRATION_FAILED}: ${message}`);
  (err as NodeJS.ErrnoException).code = STATE_MIGRATION_FAILED;
  return err;
}

function resolveStateDir(): string {
  const override = process.env.MCP_STATE_DIR;
  if (override) {
    // 相对路径只允许相对固定 projectRoot 解析一次；绝对路径经 resolve 自然生效
    return resolve(PROJECT_ROOT, override);
  }
  return join(PROJECT_ROOT, DEFAULT_STATE_DIR_NAME);
}

let cachedStateDir: string | null = null;
let migrationPromise: Promise<void> | null = null;

/** 重置状态目录缓存与迁移 memo（测试用） */
export function resetStateDirCache(): void {
  cachedStateDir = null;
  migrationPromise = null;
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
 * 旧的会话状态文件路径（系统临时目录）。
 * 4.5：不自动导入、不删除；由 session 在发现时仅记录不含内容/cwd/env 的提示。
 */
export function getLegacyStateFilePath(): string {
  return join(tmpdir(), ".enhanced-terminal-mcp-session.json");
}

/**
 * 确保旧状态目录已按 4.5 协议迁移（进程内只执行一次）。
 * 设置 MCP_STATE_DIR 时不执行自动迁移。
 * 失败抛出带 STATE_MIGRATION_FAILED 标识的错误，调用方必须停止启动。
 */
export function ensureStateMigration(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      if (process.env.MCP_STATE_DIR) return;
      await runStateMigration(PROJECT_ROOT, resolveStateDir());
    })();
    // 错误仍由 await 方处理；这里仅抑制 await 之前间隙的未处理拒绝噪音
    migrationPromise.catch(() => {});
  }
  return migrationPromise;
}

// ============================================================
// 迁移引擎
// ============================================================

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
}

async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** 严格 UTF-8 解码；失败即"编码无法安全验证"，停止迁移 */
function decodeUtf8Strict(buf: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw migrationError(`编码无法安全验证: ${label}`);
  }
}

function parseJsonOrThrow(text: string, label: string): void {
  try {
    JSON.parse(text);
  } catch {
    throw migrationError(`JSON 损坏: ${label}`);
  }
}

/**
 * 流式逐行读取 JSONL（有界内存），严格 UTF-8 解码，剥 \r、跳过空行。
 */
async function* iterateJsonlLines(file: string): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const stream = createReadStream(file);
  let pending = "";
  try {
    for await (const chunk of stream) {
      let text: string;
      try {
        text = decoder.decode(chunk as Buffer, { stream: true });
      } catch {
        throw migrationError(`编码无法安全验证: ${file}`);
      }
      pending += text;
      let idx = pending.indexOf("\n");
      while (idx >= 0) {
        let line = pending.slice(0, idx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        pending = pending.slice(idx + 1);
        if (line.length > 0) yield line;
        idx = pending.indexOf("\n");
      }
    }
    let tail: string;
    try {
      tail = pending + decoder.decode();
    } catch {
      throw migrationError(`编码无法安全验证: ${file}`);
    }
    if (tail.endsWith("\r")) tail = tail.slice(0, -1);
    if (tail.length > 0) yield tail;
  } finally {
    stream.destroy();
  }
}

/** 逐行验证 JSONL：任一行无法解析即停止，不得覆盖任一原文件 */
async function validateJsonl(file: string): Promise<void> {
  for await (const line of iterateJsonlLines(file)) {
    try {
      JSON.parse(line);
    } catch {
      throw migrationError(`audit.jsonl 存在无法解析的行: ${file}`);
    }
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt++) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.close();
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw migrationError(`迁移锁创建失败: ${lockPath} (${String(e)})`);
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
    }
  }
  throw migrationError(`迁移锁获取超时: ${lockPath}`);
}

/**
 * 同卷 staging 写入 + staging 回读验证 + 源指纹复核 + 原子替换 + 目标回读验证。
 * 失败时清理 staging，源与已有目标保持不变。
 */
async function atomicReplaceVerified(src: string, buf: Buffer, dst: string, srcBefore: FileFingerprint): Promise<void> {
  const srcAfterRead = await fs.lstat(src);
  if (!sameFingerprint(srcBefore, srcAfterRead)) {
    throw migrationError(`迁移期间源文件发生变化: ${src}`);
  }
  await fs.mkdir(dirname(dst), { recursive: true });
  const staging = join(dirname(dst), `.${basename(dst)}.migrate-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(staging, buf);
    const staged = await fs.readFile(staging);
    if (sha256(staged) !== sha256(buf)) {
      throw migrationError(`staging 回读验证失败: ${staging}`);
    }
    const srcFinal = await fs.lstat(src);
    if (!sameFingerprint(srcBefore, srcFinal)) {
      throw migrationError(`迁移期间源文件发生变化: ${src}`);
    }
    await fs.rename(staging, dst);
  } catch (e) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw e;
  }
  const written = await fs.readFile(dst);
  if (sha256(written) !== sha256(buf)) {
    throw migrationError(`目标回读验证失败: ${dst}`);
  }
}

async function migrateSessionJson(legacyRoot: string, stateDir: string): Promise<void> {
  const src = join(legacyRoot, "session.json");
  const srcStat = await lstatOrNull(src);
  if (!srcStat) return;
  if (srcStat.isSymbolicLink()) {
    logger.warn("state-dir", "migration-symlink-skipped", src);
    return;
  }
  if (!srcStat.isFile()) {
    throw migrationError(`旧 session.json 不是常规文件: ${src}`);
  }
  const dst = join(stateDir, "session.json");
  const dstStat = await lstatOrNull(dst);
  if (dstStat) {
    if (dstStat.isSymbolicLink() || !dstStat.isFile()) {
      throw migrationError(`目标 session.json 状态异常: ${dst}`);
    }
    // 目标为权威：两侧都必须有效，否则停止启动；不合并、不覆盖，源保留
    parseJsonOrThrow(decodeUtf8Strict(await fs.readFile(dst), dst), dst);
    parseJsonOrThrow(decodeUtf8Strict(await fs.readFile(src), src), src);
    logger.info("state-dir", "migration", `skipped_target_exists: ${src}`);
    return;
  }
  // 目标不存在、源有效：原子迁移 + 回读验证，成功后删除源
  const before = await fs.lstat(src);
  const buf = await fs.readFile(src);
  parseJsonOrThrow(decodeUtf8Strict(buf, src), src);
  await atomicReplaceVerified(src, buf, dst, before);
  await fs.unlink(src);
  logger.info("state-dir", "migration", `migrated: ${src} -> ${dst}`);
}

async function migrateAuditJsonl(legacyRoot: string, stateDir: string): Promise<void> {
  const logsDir = join(legacyRoot, "logs");
  const logsStat = await lstatOrNull(logsDir);
  if (!logsStat) return;
  if (logsStat.isSymbolicLink()) {
    logger.warn("state-dir", "migration-symlink-skipped", logsDir);
    return;
  }
  if (!logsStat.isDirectory()) {
    throw migrationError(`旧 logs 不是目录: ${logsDir}`);
  }
  const src = join(logsDir, "audit.jsonl");
  const srcStat = await lstatOrNull(src);
  if (!srcStat) return;
  if (srcStat.isSymbolicLink()) {
    logger.warn("state-dir", "migration-symlink-skipped", src);
    return;
  }
  if (!srcStat.isFile()) {
    throw migrationError(`旧 audit.jsonl 不是常规文件: ${src}`);
  }
  const dst = join(stateDir, "logs", "audit.jsonl");
  const dstStat = await lstatOrNull(dst);
  if (!dstStat) {
    // 目标不存在：逐行验证后原子迁移 + 回读验证，成功后删除源
    await validateJsonl(src);
    const before = await fs.lstat(src);
    const buf = await fs.readFile(src);
    await atomicReplaceVerified(src, buf, dst, before);
    await fs.unlink(src);
    logger.info("state-dir", "migration", `migrated: ${src} -> ${dst}`);
    return;
  }
  if (dstStat.isSymbolicLink() || !dstStat.isFile()) {
    throw migrationError(`目标 audit.jsonl 状态异常: ${dst}`);
  }
  await mergeAuditJsonl(src, dst);
}

/**
 * 新旧 audit 同时存在：旧记录在前、新记录在后，流式精确去重（Set<sha256>），
 * 合并结果回读验证后才删除旧 audit；任一行无法解析即停止，不覆盖任一原文件。
 */
async function mergeAuditJsonl(src: string, dst: string): Promise<void> {
  const srcBefore = await fs.lstat(src);
  const dstBefore = await fs.lstat(dst);
  await fs.mkdir(dirname(dst), { recursive: true });
  const staging = join(dirname(dst), `.audit.jsonl.migrate-${process.pid}-${Date.now()}.tmp`);
  const seen = new Set<string>();
  let written = 0;
  try {
    const out = await fs.open(staging, "w");
    try {
      for (const file of [src, dst]) {
        for await (const line of iterateJsonlLines(file)) {
          try {
            JSON.parse(line);
          } catch {
            throw migrationError(`audit.jsonl 存在无法解析的行: ${file}`);
          }
          const hash = sha256(Buffer.from(line, "utf-8"));
          if (seen.has(hash)) continue;
          seen.add(hash);
          await out.writeFile(`${line}\n`, "utf-8");
          written++;
        }
      }
    } finally {
      await out.close();
    }
    // staging 回读验证：合并结果全部行可解析
    await validateJsonl(staging);
    // 迁移期间源/目标变化即中止
    const srcAfter = await fs.lstat(src);
    const dstAfter = await fs.lstat(dst);
    if (!sameFingerprint(srcBefore, srcAfter) || !sameFingerprint(dstBefore, dstAfter)) {
      throw migrationError(`迁移期间源文件发生变化: ${src} / ${dst}`);
    }
    await fs.rename(staging, dst);
  } catch (e) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw e;
  }
  // 目标回读验证通过后才删除旧 audit
  await validateJsonl(dst);
  await fs.unlink(src);
  logger.info("state-dir", "migration", `merged: ${src} -> ${dst} (${written} lines)`);
}

/**
 * 执行 4.5 迁移事务（导出供测试注入根目录；生产由 ensureStateMigration 调用）。
 *
 * 删除门禁：永不迁移/删除旧 temp；永不删除未知文件；只删除已迁移并验证的
 * 源文件；旧 logs 仅在空时移除；旧根仅在完全为空时移除。
 */
export async function runStateMigration(projectRoot: string, stateDir: string): Promise<void> {
  const legacyRoot = join(projectRoot, LEGACY_STATE_DIR_NAME);
  const legacyStat = await lstatOrNull(legacyRoot);
  if (!legacyStat) return;
  if (legacyStat.isSymbolicLink()) {
    logger.warn("state-dir", "migration-symlink-skipped", legacyRoot);
    return;
  }
  if (!legacyStat.isDirectory()) return;

  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, LOCK_FILE_NAME);
  await acquireLock(lockPath);
  try {
    await migrateSessionJson(legacyRoot, stateDir);
    await migrateAuditJsonl(legacyRoot, stateDir);
    // 仅空目录才可移除（rmdir 对非空目录必然失败）；非空（temp/未知文件/被跳过的源）时保留
    await fs.rmdir(join(legacyRoot, "logs")).catch(() => {});
    await fs.rmdir(legacyRoot).catch(() => {});
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}
