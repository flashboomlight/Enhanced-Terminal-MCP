/**
 * 命令输出分页缓存 v2
 *
 * 使用原始字节、版本化字符索引和 staging 原子发布；读取只加载目标页范围。
 *
 * 结构（2026-08-28 structural-debt-cleanup R2 拆分）：
 * - paging/codec.ts        字节编解码（UTF-8/GBK 单元、编码探测）
 * - paging/errors.ts       PageCacheCorruptError / PageCacheReadError
 * - paging/index-format.ts stdout.idx 二进制索引与 checkpoint 定位
 * - paging/paths.ts        路径安全断言
 * - paging.ts（本文件）    公开类型、writer/reader 编排与 facade re-export
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { CaptureStreamName } from "./capture.js";
import { logger } from "./logger.js";
import {
  type ByteUnit,
  decodeCompleteUnits,
  detectEncoding,
  expectedUnitBytes,
  gbkDecoder,
  type PageEncoding,
  readUnit,
  utf8Decoder,
} from "./paging/codec.js";
import { PageCacheCorruptError, PageCacheReadError } from "./paging/errors.js";
import {
  buildIndex,
  encodeIndex,
  findCheckpoint,
  findEndByte,
  INDEX_STRIDE_CHARS,
  type IndexRecord,
  readIndex,
} from "./paging/index-format.js";
import { assertFourFiles, assertRegularPath, isInside, isSafeNumber } from "./paging/paths.js";
import { getStateDir } from "./state-dir.js";
import { type TempStaging, tempManager } from "./temp-manager.js";

export type { PageEncoding } from "./paging/codec.js";
export { PageCacheCorruptError, PageCacheReadError } from "./paging/errors.js";

const DEFAULT_PAGE_SIZE = 2000;
const MAX_PAGE_SIZE = 10000;
const IO_CHUNK_BYTES = 64 * 1024;
const CACHE_ID_PATTERN = /^page-cache-[0-9]{13}-[0-9a-f]{32}$/;

export interface PageCacheError {
  code: string;
  message: string;
  retryable: boolean;
  suggestion?: string;
  param?: string;
  detail?: unknown;
}

interface PageMeta {
  schema_version: 2;
  complete: true;
  cache_id: string;
  stdout_encoding: PageEncoding;
  stderr_encoding: PageEncoding;
  stdout_data_start: number;
  stderr_data_start: number;
  stdout_total_bytes: number;
  stderr_total_bytes: number;
  stdout_retained_bytes: number;
  stderr_retained_bytes: number;
  total_output_bytes: number;
  retained_output_bytes: number;
  total_chars: number;
  page_size: number;
  exit_code: number | null;
  timed_out: boolean;
  capture_limit_reached: boolean;
  truncated: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  error?: PageCacheError;
  createdAt: number;
  lastAccessedAt: number;
}

interface CacheBytesOptions {
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  pageSize?: number;
  timedOut?: boolean;
  captureLimitReached?: boolean;
  truncated?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutTotalBytes?: number;
  stderrTotalBytes?: number;
  error?: PageCacheError;
}

export interface PageCacheEntry {
  id: string;
  dir: string;
  command?: string;
  cwd?: string;
  exitCode: number | null;
  stderr?: string;
  createdAt: number;
  lastAccessedAt: number;
  stdoutEncoding: PageEncoding;
  stderrEncoding: PageEncoding;
  stdoutDataStart: number;
  stderrDataStart: number;
  stdoutTotalBytes: number;
  stderrTotalBytes: number;
  stdoutRetainedBytes: number;
  stderrRetainedBytes: number;
  totalOutputBytes: number;
  retainedOutputBytes: number;
  totalChars: number;
  pageSize: number;
  totalPages: number;
  timedOut: boolean;
  captureLimitReached: boolean;
  truncated: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: PageCacheError;
}

export interface PageResult {
  content: string;
  cache_id: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  capture_limit_reached: boolean;
  truncated: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  page: number;
  total_pages: number;
  page_size: number;
  total_chars: number;
  stdout_encoding: PageEncoding;
  stderr_encoding: PageEncoding;
  total_output_bytes: number;
  retained_output_bytes: number;
  stdout_total_bytes: number;
  stderr_total_bytes: number;
  stdout_retained_bytes: number;
  stderr_retained_bytes: number;
  error?: PageCacheError;
}

interface LoadedEntry extends PageCacheEntry {
  records: IndexRecord[];
}

/** 将 pageSize 限制在公开契约范围内 */
function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(pageSize)));
}

/** 将一个已计算的原始文件写入 staging 并同步 reservation 记账 */
async function writeStagedFile(
  dir: string,
  name: string,
  data: Buffer,
  reservation: { reserve(bytes: number): Promise<void>; markWritten(bytes: number): void },
): Promise<void> {
  await reservation.reserve(data.length);
  await fs.writeFile(path.join(dir, name), data);
  reservation.markWritten(data.length);
}

/** 将有限范围的原始 stdout 增量解码为 code point 页正文 */
async function readStdoutRange(
  file: string,
  encoding: PageEncoding,
  startByte: number,
  endByte: number,
  skipChars: number,
  takeChars: number,
): Promise<string> {
  const handle = await fs.open(file, "r");
  const parts: string[] = [];
  let position = startByte;
  let pending = Buffer.alloc(0);
  let skipped = 0;
  let taken = 0;
  try {
    while (position < endByte && taken < takeChars) {
      const length = Math.min(IO_CHUNK_BYTES, endByte - position);
      const chunk = Buffer.alloc(length);
      const result = await handle.read(chunk, 0, length, position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      const combined =
        pending.length === 0
          ? chunk.subarray(0, result.bytesRead)
          : Buffer.concat([pending, chunk.subarray(0, result.bytesRead)]);
      const decoded = decodeCompleteUnits(combined, encoding);
      pending = combined.subarray(decoded.consumed);
      for (const character of Array.from(decoded.text)) {
        if (skipped < skipChars) {
          skipped++;
        } else if (taken < takeChars) {
          parts.push(character);
          taken++;
        }
      }
    }
    if (pending.length > 0 && taken < takeChars) {
      const decoded = decodeCompleteUnits(pending, encoding);
      for (const character of Array.from(decoded.text)) {
        if (skipped < skipChars) skipped++;
        else if (taken < takeChars) {
          parts.push(character);
          taken++;
        }
      }
    }
    return parts.join("");
  } finally {
    await handle.close();
  }
}

/** 读取小型 stderr 诊断文件；不会加载 stdout 整体 */
async function readStderr(file: string, encoding: PageEncoding, expectedBytes: number): Promise<string> {
  const stat = await assertRegularPath(file, "file");
  if (stat.size !== expectedBytes) throw new PageCacheCorruptError("stderr.bin size does not match meta.json");
  const raw = await fs.readFile(file);
  const dataStart = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
  return (encoding === "utf8" ? utf8Decoder : gbkDecoder).decode(raw.subarray(dataStart));
}

/** 将磁盘元数据转换为公开缓存条目 */
function entryFromMeta(meta: PageMeta, dir: string): PageCacheEntry {
  const totalPages = Math.max(1, Math.ceil(meta.total_chars / meta.page_size));
  return {
    id: meta.cache_id,
    dir,
    exitCode: meta.exit_code,
    createdAt: meta.createdAt,
    lastAccessedAt: meta.lastAccessedAt,
    stdoutEncoding: meta.stdout_encoding,
    stderrEncoding: meta.stderr_encoding,
    stdoutDataStart: meta.stdout_data_start,
    stderrDataStart: meta.stderr_data_start,
    stdoutTotalBytes: meta.stdout_total_bytes,
    stderrTotalBytes: meta.stderr_total_bytes,
    stdoutRetainedBytes: meta.stdout_retained_bytes,
    stderrRetainedBytes: meta.stderr_retained_bytes,
    totalOutputBytes: meta.total_output_bytes,
    retainedOutputBytes: meta.retained_output_bytes,
    totalChars: meta.total_chars,
    pageSize: meta.page_size,
    totalPages,
    timedOut: meta.timed_out,
    captureLimitReached: meta.capture_limit_reached,
    truncated: meta.truncated,
    stdoutTruncated: meta.stdout_truncated,
    stderrTruncated: meta.stderr_truncated,
    error: meta.error,
  };
}

/** 验证并解析白名单 meta.json */
function parseMeta(raw: string, id: string): PageMeta {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new PageCacheCorruptError(`Invalid meta.json: ${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PageCacheCorruptError("meta.json must be an object");
  }
  const meta = value as Partial<PageMeta>;
  const requiredNumbers: Array<keyof PageMeta> = [
    "stdout_data_start",
    "stderr_data_start",
    "stdout_total_bytes",
    "stderr_total_bytes",
    "stdout_retained_bytes",
    "stderr_retained_bytes",
    "total_output_bytes",
    "retained_output_bytes",
    "total_chars",
    "page_size",
    "createdAt",
    "lastAccessedAt",
  ];
  if (
    meta.schema_version !== 2 ||
    meta.complete !== true ||
    meta.cache_id !== id ||
    !["utf8", "gbk"].includes(meta.stdout_encoding ?? "") ||
    !["utf8", "gbk"].includes(meta.stderr_encoding ?? "") ||
    (meta.exit_code !== null && typeof meta.exit_code !== "number")
  ) {
    throw new PageCacheCorruptError("meta.json identity or enum fields are invalid");
  }
  for (const key of requiredNumbers) {
    if (!isSafeNumber(meta[key])) throw new PageCacheCorruptError(`meta.json numeric field is invalid: ${String(key)}`);
  }
  for (const key of [
    "timed_out",
    "capture_limit_reached",
    "truncated",
    "stdout_truncated",
    "stderr_truncated",
  ] as const) {
    if (typeof meta[key] !== "boolean") throw new PageCacheCorruptError(`meta.json boolean field is invalid: ${key}`);
  }
  return meta as PageMeta;
}

/** Page cache staging finalize 选项；不含 command/cwd 等敏感上下文。 */
export interface PageCacheWriterFinalizeOptions {
  exitCode?: number | null;
  timedOut?: boolean;
  captureLimitReached?: boolean;
  truncated?: boolean;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  stdoutTotalBytes?: number;
  stderrTotalBytes?: number;
  error?: PageCacheError;
}

/** staging 追加写入：reservation 只为真正写入的字节增量记账。 */
async function appendStagedFile(
  dir: string,
  name: string,
  data: Buffer,
  reservation: { reserve(bytes: number): Promise<void>; markWritten(bytes: number): void },
): Promise<void> {
  if (data.length === 0) return;
  await reservation.reserve(data.length);
  await fs.appendFile(path.join(dir, name), data);
  reservation.markWritten(data.length);
}

/** 按固定 chunk 读取文件并逐单元回调，不把完整 stdout 载入内存。 */
async function forEachFileUnit(
  file: string,
  encoding: PageEncoding,
  dataStart: number,
  onUnit: (unit: ByteUnit, start: number, end: number) => void,
): Promise<void> {
  const handle = await fs.open(file, "r");
  let position = dataStart;
  let pending = Buffer.alloc(0);
  let pendingStart = dataStart;
  try {
    while (true) {
      const chunk = Buffer.alloc(IO_CHUNK_BYTES);
      const result = await handle.read(chunk, 0, chunk.length, position);
      if (result.bytesRead === 0) break;
      position += result.bytesRead;
      const current = chunk.subarray(0, result.bytesRead);
      const combined = pending.length === 0 ? current : Buffer.concat([pending, current]);
      const base = pendingStart;
      let offset = 0;
      while (offset < combined.length) {
        const expected = expectedUnitBytes(combined, offset, encoding);
        if (combined.length - offset < expected) break;
        const unit = readUnit(combined, offset, encoding);
        if (unit.next <= offset) break;
        onUnit(unit, base + offset, base + unit.next);
        offset = unit.next;
      }
      pending = combined.subarray(offset);
      pendingStart = base + offset;
    }
    let offset = 0;
    while (offset < pending.length) {
      const unit = readUnit(pending, offset, encoding);
      if (unit.next <= offset) break;
      onUnit(unit, pendingStart + offset, pendingStart + unit.next);
      offset = unit.next;
    }
  } finally {
    await handle.close();
  }
}

/** 判断磁盘文件编码；Windows 只在完整内容不是 UTF-8 时使用 GBK。 */
async function detectFileEncoding(file: string): Promise<{ encoding: PageEncoding; dataStart: number }> {
  const handle = await fs.open(file, "r");
  const header = Buffer.alloc(3);
  let bytesRead = 0;
  try {
    bytesRead = (await handle.read(header, 0, header.length, 0)).bytesRead;
  } finally {
    await handle.close();
  }
  if (bytesRead === 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) {
    return { encoding: "utf8", dataStart: 3 };
  }
  if (process.platform !== "win32") return { encoding: "utf8", dataStart: 0 };
  let valid = true;
  await forEachFileUnit(file, "utf8", 0, (unit) => {
    if (!unit.valid) valid = false;
  });
  return valid ? { encoding: "utf8", dataStart: 0 } : { encoding: "gbk", dataStart: 0 };
}

/** 生成 stdout 的固定 stride 字符索引。 */
async function buildFileIndex(
  file: string,
  encoding: PageEncoding,
  dataStart: number,
  expectedBytes: number,
): Promise<{ records: IndexRecord[]; totalChars: number }> {
  const records: IndexRecord[] = [{ charOffset: 0n, byteOffset: BigInt(dataStart) }];
  let totalChars = 0;
  await forEachFileUnit(file, encoding, dataStart, (unit, _start, end) => {
    const count = Array.from(unit.text).length;
    for (let i = 0; i < count; i++) {
      totalChars++;
      if (totalChars % INDEX_STRIDE_CHARS === 0) {
        records.push({ charOffset: BigInt(totalChars), byteOffset: BigInt(end) });
      }
    }
  });
  if (totalChars > 0 && records[records.length - 1].charOffset !== BigInt(totalChars)) {
    records.push({ charOffset: BigInt(totalChars), byteOffset: BigInt(expectedBytes) });
  }
  return { records, totalChars };
}

/** 截断模式下移除文件末尾不完整的 UTF-8/GBK 单元。 */
async function trimIncompleteTail(file: string, encoding: PageEncoding, dataStart: number): Promise<number> {
  const stat = await fs.stat(file);
  let size = stat.size;
  if (size <= dataStart) return size;
  const tailSize = Math.min(4, size - dataStart);
  const handle = await fs.open(file, "r");
  const tail = Buffer.alloc(tailSize);
  try {
    await handle.read(tail, 0, tailSize, size - tailSize);
  } finally {
    await handle.close();
  }
  let trimmed = size;
  if (encoding === "gbk") {
    const last = tail[tail.length - 1];
    if (last >= 0x81 && last <= 0xfe) trimmed = size - 1;
  } else {
    let continuation = 0;
    for (let i = tail.length - 1; i >= 0 && tail[i] >= 0x80 && tail[i] <= 0xbf; i--) continuation++;
    if (continuation > 0 && continuation < tail.length) {
      const lead = tail[tail.length - continuation - 1];
      const expected =
        lead <= 0x7f
          ? 1
          : lead >= 0xc2 && lead <= 0xdf
            ? 2
            : lead >= 0xe0 && lead <= 0xef
              ? 3
              : lead >= 0xf0 && lead <= 0xf4
                ? 4
                : 1;
      if (expected !== continuation + 1) trimmed = size - continuation - 1;
    } else if (continuation === 0) {
      const last = tail[tail.length - 1];
      const expected = expectedUnitBytes(Buffer.from([last]), 0, "utf8");
      if (expected > 1) trimmed = size - 1;
    }
  }
  if (trimmed !== size) {
    await fs.truncate(file, trimmed);
    size = trimmed;
  }
  return size;
}

/** 可增量写入、最终原子发布的 page cache staging writer。 */
export class PageCacheWriter {
  private stdoutChain = Promise.resolve();
  private stderrChain = Promise.resolve();
  private finalized = false;

  private constructor(
    private readonly staging: TempStaging,
    private readonly pageSize: number,
  ) {}

  /** 创建 staging；此时只创建 inflight 目录，不暴露 cache_id。 */
  static async create(pageSize?: number): Promise<PageCacheWriter> {
    const staging = await tempManager.createStaging({ prefix: "inflight-page-cache" });
    return new PageCacheWriter(staging, clampPageSize(pageSize));
  }

  /** 将已通过 scanner 的字节追加到对应流文件，并按流保持顺序。 */
  write(stream: CaptureStreamName, data: Buffer): Promise<void> {
    const append = () => appendStagedFile(this.staging.dir, `${stream}.bin`, data, this.staging.reservation);
    if (stream === "stdout") {
      this.stdoutChain = this.stdoutChain.then(append);
      return this.stdoutChain;
    }
    this.stderrChain = this.stderrChain.then(append);
    return this.stderrChain;
  }

  /** 完成索引、meta 和原子 rename；错误由调用方决定如何降级。 */
  async finalize(options: PageCacheWriterFinalizeOptions = {}): Promise<PageCacheEntry> {
    if (this.finalized) throw new Error("Page cache writer already finalized");
    await Promise.all([this.stdoutChain, this.stderrChain]);
    const stdoutFile = path.join(this.staging.dir, "stdout.bin");
    const stderrFile = path.join(this.staging.dir, "stderr.bin");
    await fs.access(stdoutFile).catch(() => fs.writeFile(stdoutFile, Buffer.alloc(0)));
    await fs.access(stderrFile).catch(() => fs.writeFile(stderrFile, Buffer.alloc(0)));
    let stdoutEncoding = await detectFileEncoding(stdoutFile);
    let stderrEncoding = await detectFileEncoding(stderrFile);
    let stdoutBytes = (await fs.stat(stdoutFile)).size;
    let stderrBytes = (await fs.stat(stderrFile)).size;
    if (options.stdoutTruncated) {
      stdoutBytes = await trimIncompleteTail(stdoutFile, stdoutEncoding.encoding, stdoutEncoding.dataStart);
      stdoutEncoding = await detectFileEncoding(stdoutFile);
    }
    if (options.stderrTruncated) {
      stderrBytes = await trimIncompleteTail(stderrFile, stderrEncoding.encoding, stderrEncoding.dataStart);
      stderrEncoding = await detectFileEncoding(stderrFile);
    }
    const stdoutIndex = await buildFileIndex(
      stdoutFile,
      stdoutEncoding.encoding,
      stdoutEncoding.dataStart,
      stdoutBytes,
    );
    const cacheId = `page-cache-${Date.now().toString().padStart(13, "0")}-${randomBytes(16).toString("hex")}`;
    const now = Date.now();
    const meta: PageMeta = {
      schema_version: 2,
      complete: true,
      cache_id: cacheId,
      stdout_encoding: stdoutEncoding.encoding,
      stderr_encoding: stderrEncoding.encoding,
      stdout_data_start: stdoutEncoding.dataStart,
      stderr_data_start: stderrEncoding.dataStart,
      stdout_total_bytes: options.stdoutTotalBytes ?? stdoutBytes,
      stderr_total_bytes: options.stderrTotalBytes ?? stderrBytes,
      stdout_retained_bytes: stdoutBytes,
      stderr_retained_bytes: stderrBytes,
      total_output_bytes: (options.stdoutTotalBytes ?? stdoutBytes) + (options.stderrTotalBytes ?? stderrBytes),
      retained_output_bytes: stdoutBytes + stderrBytes,
      total_chars: stdoutIndex.totalChars,
      page_size: this.pageSize,
      exit_code: options.exitCode ?? 0,
      timed_out: options.timedOut ?? false,
      capture_limit_reached: options.captureLimitReached ?? false,
      truncated: options.truncated ?? false,
      stdout_truncated: options.stdoutTruncated ?? false,
      stderr_truncated: options.stderrTruncated ?? false,
      error: options.error,
      createdAt: now,
      lastAccessedAt: now,
    };
    await writeStagedFile(
      this.staging.dir,
      "stdout.idx",
      encodeIndex(stdoutEncoding.encoding, stdoutIndex.records),
      this.staging.reservation,
    );
    await writeStagedFile(
      this.staging.dir,
      "meta.json",
      Buffer.from(JSON.stringify(meta), "utf-8"),
      this.staging.reservation,
    );
    const finalDir = await tempManager.finalizeStaging(this.staging, cacheId, { metadataFile: "meta.json" });
    await assertFourFiles(finalDir.dir);
    this.finalized = true;
    return entryFromMeta(meta, finalDir.dir);
  }

  /** 丢弃 staging，并保证 reservation/heartbeat 一并释放。 */
  async discard(): Promise<void> {
    await Promise.allSettled([this.stdoutChain, this.stderrChain]);
    if (!this.finalized) await this.staging.discard();
  }
}

export class PageCache {
  private entries = new Map<string, PageCacheEntry>();

  /** 将刚发布的 cache 注册到进程内索引，保留 command/cwd 等非磁盘上下文。 */
  remember(entry: PageCacheEntry): void {
    this.entries.set(entry.id, entry);
  }

  /** 兼容字符串调用方：以 UTF-8 原始字节进入 v2 缓存。 */
  async cache(
    command: string,
    cwd: string,
    exitCode: number,
    stdout: string,
    stderr: string,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<PageCacheEntry> {
    return this.cacheBytes(Buffer.from(stdout), Buffer.from(stderr), {
      command,
      cwd,
      exitCode,
      pageSize,
    });
  }

  /** 以原始字节发布 page cache v2；command/cwd 只留在进程内，不写 meta。 */
  async cacheBytes(stdout: Buffer, stderr: Buffer, options: CacheBytesOptions = {}): Promise<PageCacheEntry> {
    const pageSize = clampPageSize(options.pageSize);
    const stdoutEncoding = detectEncoding(stdout);
    const stderrEncoding = detectEncoding(stderr);
    const stdoutIndex = buildIndex(stdout, stdoutEncoding.encoding, stdoutEncoding.dataStart);
    const cacheId = `page-cache-${Date.now().toString().padStart(13, "0")}-${randomBytes(16).toString("hex")}`;
    const now = Date.now();
    const meta: PageMeta = {
      schema_version: 2,
      complete: true,
      cache_id: cacheId,
      stdout_encoding: stdoutEncoding.encoding,
      stderr_encoding: stderrEncoding.encoding,
      stdout_data_start: stdoutEncoding.dataStart,
      stderr_data_start: stderrEncoding.dataStart,
      stdout_total_bytes: stdout.length,
      stderr_total_bytes: stderr.length,
      stdout_retained_bytes: stdout.length,
      stderr_retained_bytes: stderr.length,
      total_output_bytes: stdout.length + stderr.length,
      retained_output_bytes: stdout.length + stderr.length,
      total_chars: stdoutIndex.totalChars,
      page_size: pageSize,
      exit_code: options.exitCode ?? 0,
      timed_out: options.timedOut ?? false,
      capture_limit_reached: options.captureLimitReached ?? false,
      truncated: options.truncated ?? false,
      stdout_truncated: options.stdoutTruncated ?? false,
      stderr_truncated: options.stderrTruncated ?? false,
      error: options.error,
      createdAt: now,
      lastAccessedAt: now,
    };
    let staging: TempStaging | null = null;
    try {
      staging = await tempManager.createStaging({ prefix: "inflight-page-cache" });
      await writeStagedFile(staging.dir, "stdout.bin", stdout, staging.reservation);
      await writeStagedFile(staging.dir, "stderr.bin", stderr, staging.reservation);
      const index = encodeIndex(stdoutEncoding.encoding, stdoutIndex.records);
      await writeStagedFile(staging.dir, "stdout.idx", index, staging.reservation);
      const metaBytes = Buffer.from(JSON.stringify(meta), "utf-8");
      await writeStagedFile(staging.dir, "meta.json", metaBytes, staging.reservation);
      const finalDir = await tempManager.finalizeStaging(staging, cacheId, { metadataFile: "meta.json" });
      await assertFourFiles(finalDir.dir);
      const entry = entryFromMeta(meta, finalDir.dir);
      entry.command = options.command;
      entry.cwd = options.cwd;
      this.entries.set(cacheId, entry);
      return entry;
    } catch (error) {
      if (staging) {
        await staging
          .discard()
          .catch((discardError) => logger.warn("page-cache", "staging-discard-failed", String(discardError)));
      }
      logger.warn("page-cache", "cache-failed", String(error));
      throw error;
    }
  }

  /** 从固定 temp root 加载并校验一个 page cache。 */
  private async loadEntry(id: string): Promise<LoadedEntry | null> {
    if (!CACHE_ID_PATTERN.test(id)) {
      logger.debug("page-cache", "invalid-cache-id", id);
      return null;
    }
    const stateDir = await getStateDir();
    const root = path.resolve(stateDir, "temp");
    let rootStat: import("node:fs").Stats;
    try {
      rootStat = await fs.lstat(root);
    } catch {
      return null;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const dir = path.resolve(root, id);
    if (!isInside(root, dir)) return null;
    let dirStat: import("node:fs").Stats;
    try {
      dirStat = await fs.lstat(dir);
    } catch {
      return null;
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    await assertFourFiles(dir);
    const metaFile = path.join(dir, "meta.json");
    const rawMeta = await fs.readFile(metaFile, "utf-8");
    const meta = parseMeta(rawMeta, id);
    const stdoutFile = path.join(dir, "stdout.bin");
    const stderrFile = path.join(dir, "stderr.bin");
    const indexFile = path.join(dir, "stdout.idx");
    const stdoutStat = await assertRegularPath(stdoutFile, "file");
    const stderrStat = await assertRegularPath(stderrFile, "file");
    await assertRegularPath(indexFile, "file");
    if (
      stdoutStat.size !== meta.stdout_retained_bytes ||
      stderrStat.size !== meta.stderr_retained_bytes ||
      meta.stdout_retained_bytes > meta.stdout_total_bytes ||
      meta.stderr_retained_bytes > meta.stderr_total_bytes ||
      meta.stdout_data_start > meta.stdout_retained_bytes ||
      meta.stderr_data_start > meta.stderr_retained_bytes ||
      meta.total_output_bytes !== meta.stdout_total_bytes + meta.stderr_total_bytes ||
      meta.retained_output_bytes !== meta.stdout_retained_bytes + meta.stderr_retained_bytes
    ) {
      throw new PageCacheCorruptError("Cache file sizes and meta.json statistics disagree");
    }
    const records = await readIndex(
      indexFile,
      meta.stdout_encoding,
      stdoutStat.size,
      meta.stdout_data_start,
      meta.total_chars,
    );
    const entry = entryFromMeta(meta, dir);
    const memoryEntry = this.entries.get(id);
    if (memoryEntry) {
      entry.command = memoryEntry.command;
      entry.cwd = memoryEntry.cwd;
    }
    return { ...entry, records };
  }

  /** 读取指定页并区分可由 handler 转译的只读错误；成功后才刷新 TTL。 */
  async read(id: string, page: number, pageSize?: number): Promise<PageResult> {
    if (!CACHE_ID_PATTERN.test(id)) {
      throw new PageCacheReadError("cache_invalid_id", `Invalid page cache id: ${id}`);
    }
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new PageCacheReadError("cache_page_out_of_range", `Invalid page: ${page}`);
    }
    const stateDir = await getStateDir();
    const root = path.resolve(stateDir, "temp");
    try {
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new PageCacheReadError("cache_not_found", `Paged output not found: ${id}`, { retryable: true });
      }
    } catch (error) {
      if (error instanceof PageCacheReadError) throw error;
      throw new PageCacheReadError("cache_not_found", `Paged output not found: ${id}`, { retryable: true });
    }
    return tempManager.withTempLock(
      async () => {
        let active = false;
        try {
          const loaded = await this.loadEntry(id);
          if (!loaded) {
            throw new PageCacheReadError("cache_not_found", `Paged output not found: ${id}`, { retryable: true });
          }
          tempManager.markActive(id);
          active = true;
          const effectivePageSize = pageSize === undefined ? loaded.pageSize : clampPageSize(pageSize);
          const totalPages = Math.max(1, Math.ceil(loaded.totalChars / effectivePageSize));
          if (page > totalPages) {
            throw new PageCacheReadError(`cache_page_out_of_range`, `Page ${page} is out of range`, {
              detail: { total_pages: totalPages },
            });
          }
          const startChar = (page - 1) * effectivePageSize;
          const endChar = Math.min(loaded.totalChars, startChar + effectivePageSize);
          const checkpoint = findCheckpoint(loaded.records, startChar);
          const endByte = findEndByte(loaded.records, endChar, loaded.stdoutRetainedBytes);
          const startByte = Number(checkpoint.byteOffset);
          if (endByte < startByte) throw new PageCacheCorruptError("Page byte range is inverted");
          const content = await readStdoutRange(
            path.join(loaded.dir, "stdout.bin"),
            loaded.stdoutEncoding,
            startByte,
            endByte,
            startChar - Number(checkpoint.charOffset),
            endChar - startChar,
          );
          const stderr =
            page === 1
              ? await readStderr(path.join(loaded.dir, "stderr.bin"), loaded.stderrEncoding, loaded.stderrRetainedBytes)
              : "";
          tempManager.touch(id);
          this.entries.set(id, loaded);
          return {
            content,
            cache_id: id,
            stderr,
            exit_code: loaded.exitCode,
            timed_out: loaded.timedOut,
            capture_limit_reached: loaded.captureLimitReached,
            truncated: loaded.truncated,
            stdout_truncated: loaded.stdoutTruncated,
            stderr_truncated: loaded.stderrTruncated,
            page,
            total_pages: totalPages,
            page_size: effectivePageSize,
            total_chars: loaded.totalChars,
            stdout_encoding: loaded.stdoutEncoding,
            stderr_encoding: loaded.stderrEncoding,
            total_output_bytes: loaded.totalOutputBytes,
            retained_output_bytes: loaded.retainedOutputBytes,
            stdout_total_bytes: loaded.stdoutTotalBytes,
            stderr_total_bytes: loaded.stderrTotalBytes,
            stdout_retained_bytes: loaded.stdoutRetainedBytes,
            stderr_retained_bytes: loaded.stderrRetainedBytes,
            error: loaded.error,
          };
        } finally {
          if (active) tempManager.unmarkActive(id);
        }
      },
      { timeoutMs: 5000 },
    );
  }

  /** 兼容旧调用方：不可读、越界和非法 ID 返回 null；损坏缓存/锁失败继续抛出。 */
  async get(id: string, page: number, pageSize?: number): Promise<PageResult | null> {
    try {
      return await this.read(id, page, pageSize);
    } catch (error) {
      if (error instanceof PageCacheReadError) return null;
      throw error;
    }
  }
}

export const pageCache = new PageCache();
