/**
 * ZipPolicy — ZIP manifest 读取、成员校验与两阶段安全解压（roadmap §5.6 ArchivePolicy 契约）
 *
 * 纯 Node 实现（零新增运行时依赖）：EOCD/ZIP64 定位 + Central Directory 解析。
 * - 阶段一（readManifest）：完整解析全部成员并校验路径/kind/加密/预算，零写入。
 * - 阶段二（extractArchive）：向 staging 目录流式解压，逐 chunk 实际计数展开字节——
 *   CD 声明大小与实际流两路预算独立生效；任何失败清理 staging。
 * - 解压侧只产生普通文件/目录：symlink/device entry 在校验层拒绝，写入路径结构上不创建链接。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { ErrorCode, type ErrorCodeType, fail, type ToolResult } from "./result.js";
import { envInt } from "./utils.js";

export type ZipResult<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

function zipFail(code: ErrorCodeType, message: string, opts?: { retryable?: boolean }): ToolResult {
  return fail(code, message, { retryable: opts?.retryable ?? false, param: "archive_path" });
}

/** 携带结构化错误码的内部异常，用于流式管线中止后统一映射 */
class ZipPolicyError extends Error {
  readonly code: ErrorCodeType;
  constructor(code: ErrorCodeType, message: string) {
    super(message);
    this.code = code;
  }
}

// ====================================================================
// 预算配置
// ====================================================================

export interface ArchiveBudgets {
  maxMembers: number;
  maxMemberBytes: number;
  maxExpandedBytes: number;
  /** 压缩比上限；仅展开量 > RATIO_FLOOR 时参与判定 */
  maxRatio: number;
}

const RATIO_FLOOR_BYTES = 64 * 1024 * 1024;
/** CD 一次性载入的尺寸上限（10000 成员的真实 CD 约 1.2MB；超过即视为损坏） */
const MAX_CD_BYTES = 128 * 1024 * 1024;

export function getArchiveBudgets(): ArchiveBudgets {
  return {
    maxMembers: envInt("MCP_ARCHIVE_MAX_MEMBERS", 10000, 1),
    maxMemberBytes: envInt("MCP_ARCHIVE_MAX_MEMBER_BYTES", 268435456, 1),
    maxExpandedBytes: envInt("MCP_ARCHIVE_MAX_EXPANDED_BYTES", 1073741824, 1),
    maxRatio: envInt("MCP_ARCHIVE_MAX_RATIO", 200, 2),
  };
}

export interface CompressBudgets {
  maxInputBytes: number;
  maxMembers: number;
}

export function getCompressBudgets(): CompressBudgets {
  return {
    maxInputBytes: envInt("MCP_ARCHIVE_MAX_INPUT_BYTES", 1073741824, 1),
    maxMembers: envInt("MCP_ARCHIVE_MAX_MEMBERS", 10000, 1),
  };
}

// ====================================================================
// 成员路径与 kind 校验
// ====================================================================

export interface ZipMember {
  /** 归一化（反斜杠→斜杠）后的相对路径；目录以 / 结尾 */
  path: string;
  kind: "file" | "directory";
  compressedBytes: number;
  expandedBytes: number;
  method: 0 | 8;
  flags: number;
  localHeaderOffset: number;
  externalAttrs: number;
  /** CD 原始名字节（用于 local header 一致性比对） */
  rawName: Buffer;
}

export interface ZipManifest {
  members: ZipMember[];
  complete: boolean;
  entryCount: number;
  inputBytes: number;
  expandedBytes: number;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * 成员路径校验与归一化：反斜杠归一 → 拒绝绝对路径/驱动器号/../控制字符/
 * Windows 保留设备名/超长。返回归一化相对路径（目录含尾 /），非法返回 null。
 */
export function validateMemberName(rawName: string): string | null {
  if (rawName.length === 0 || rawName.length > 1024) return null;
  for (const ch of rawName) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  const normalized = rawName.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null; // 绝对路径 / UNC
  if (/^[a-zA-Z]:/.test(normalized)) return null; // 驱动器号
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "..") return null; // Zip Slip
    if (WINDOWS_RESERVED.test(segment)) return null; // CON/NUL/COM1 等设备名
  }
  return normalized;
}

/** 解析 entry kind 并拒绝链接/设备类（unix mode 高 16 位；mode 0 视为 Windows 产物按名字分类） */
export function classifyEntry(
  member: Pick<ZipMember, "path" | "externalAttrs">,
): "file" | "directory" | "symlink" | "device" {
  if (member.path.endsWith("/")) return "directory";
  const unixMode = member.externalAttrs >>> 16;
  if (unixMode !== 0) {
    const fmt = unixMode & 0xf000;
    if (fmt === 0xa000) return "symlink";
    if (fmt === 0x1000 || fmt === 0x2000 || fmt === 0x6000 || fmt === 0xc000) return "device";
  }
  return "file";
}

// ====================================================================
// EOCD / ZIP64 / Central Directory 解析
// ====================================================================

const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readU16(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function readU32(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readU64(buf: Buffer, offset: number): number {
  // ZIP64 8 字节小端；预算上限远小于 Number.MAX_SAFE_INTEGER
  return Number(buf.readBigUInt64LE(offset));
}

/** 尾部扫描 EOCD（从后往前取最后一个签名一致位置） */
function locateEocd(buf: Buffer): { eocdOffset: number; entryCount: number; cdSize: number; cdOffset: number } | null {
  const minEocd = 22;
  const scanStart = Math.max(0, buf.length - (minEocd + 0xffff));
  for (let i = buf.length - minEocd; i >= scanStart; i--) {
    if (readU32(buf, i) !== EOCD_SIG) continue;
    return {
      eocdOffset: i,
      entryCount: readU16(buf, i + 10),
      cdSize: readU32(buf, i + 12),
      cdOffset: readU32(buf, i + 16),
    };
  }
  return null;
}

async function readManifestImpl(
  handle: fs.FileHandle,
  fileSize: number,
  budgets: ArchiveBudgets,
): Promise<ZipManifest> {
  const tailLen = Math.min(fileSize, 22 + 0xffff + 24);
  const tail = Buffer.alloc(tailLen);
  await handle.read(tail, 0, tailLen, fileSize - tailLen);
  const eocd = locateEocd(tail);
  if (!eocd) throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive is not a valid zip (EOCD not found)");

  let entryCount = eocd.entryCount;
  let cdSize = eocd.cdSize;
  let cdOffset = eocd.cdOffset;
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64：locator 紧邻 EOCD 之前
    const locatorOffset = eocd.eocdOffset - 20;
    if (locatorOffset >= 0 && readU32(tail, locatorOffset) === ZIP64_EOCD_LOCATOR_SIG) {
      const zip64EocdOffset = readU64(tail, locatorOffset + 8);
      const header = Buffer.alloc(56);
      await handle.read(header, 0, 56, zip64EocdOffset);
      if (readU32(header, 0) !== ZIP64_EOCD_SIG) {
        throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive ZIP64 EOCD is corrupt");
      }
      entryCount = readU64(header, 32);
      cdSize = readU64(header, 40);
      cdOffset = readU64(header, 48);
    }
  }
  if (entryCount > budgets.maxMembers) {
    throw new ZipPolicyError(
      ErrorCode.ARCHIVE_LIMIT,
      `Archive exceeds member budget (${entryCount} > ${budgets.maxMembers})`,
    );
  }
  if (cdOffset + cdSize > fileSize || cdSize > MAX_CD_BYTES) {
    throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive central directory is corrupt (out of bounds)");
  }

  const cdBuf = Buffer.alloc(cdSize);
  await handle.read(cdBuf, 0, cdSize, cdOffset);

  const members: ZipMember[] = [];
  let expandedTotal = 0;
  let inputTotal = 0;
  let offset = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > cdBuf.length || readU32(cdBuf, offset) !== CD_SIG) {
      throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive central directory entry is corrupt");
    }
    const flags = readU16(cdBuf, offset + 8);
    const method = readU16(cdBuf, offset + 10);
    let compressedBytes = readU32(cdBuf, offset + 20);
    let expandedBytes = readU32(cdBuf, offset + 24);
    const nameLen = readU16(cdBuf, offset + 28);
    const extraLen = readU16(cdBuf, offset + 30);
    const commentLen = readU16(cdBuf, offset + 32);
    const externalAttrs = readU32(cdBuf, offset + 38);
    let localHeaderOffset = readU32(cdBuf, offset + 42);
    const rawName = cdBuf.subarray(offset + 46, offset + 46 + nameLen);
    const extra = cdBuf.subarray(offset + 46 + nameLen, offset + 46 + nameLen + extraLen);

    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      throw new ZipPolicyError(ErrorCode.ARCHIVE_LIMIT, "Archive contains encrypted entries");
    }
    if (method !== 0 && method !== 8) {
      throw new ZipPolicyError(ErrorCode.ARCHIVE_LIMIT, `Archive uses unsupported compression method: ${method}`);
    }
    // ZIP64 extra field (0x0001)：按固定顺序补齐 0xFFFFFFFF 字段
    if (expandedBytes === 0xffffffff || compressedBytes === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let extraOffset = 0;
      while (extraOffset + 4 <= extra.length) {
        const fieldId = readU16(extra, extraOffset);
        const fieldSize = readU16(extra, extraOffset + 2);
        if (fieldId === 0x0001) {
          let cursor = extraOffset + 4;
          const fieldEnd = extraOffset + 4 + fieldSize;
          if (expandedBytes === 0xffffffff && cursor + 8 <= fieldEnd) {
            expandedBytes = readU64(extra, cursor);
            cursor += 8;
          }
          if (compressedBytes === 0xffffffff && cursor + 8 <= fieldEnd) {
            compressedBytes = readU64(extra, cursor);
            cursor += 8;
          }
          if (localHeaderOffset === 0xffffffff && cursor + 8 <= fieldEnd) {
            localHeaderOffset = readU64(extra, cursor);
          }
          break;
        }
        extraOffset += 4 + fieldSize;
      }
    }

    const encoding = (flags & 0x0800) !== 0 ? "utf-8" : "latin1";
    const decodedName = rawName.toString(encoding);
    const normalized = validateMemberName(decodedName);
    if (normalized === null) {
      throw new ZipPolicyError(
        ErrorCode.ARCHIVE_LIMIT,
        `Archive member path is not allowed: ${decodedName.slice(0, 80)}`,
      );
    }
    const kind = classifyEntry({ path: normalized, externalAttrs });
    if (kind === "symlink" || kind === "device") {
      throw new ZipPolicyError(
        ErrorCode.ARCHIVE_LIMIT,
        `Archive member is a ${kind} entry (rejected): ${normalized.slice(0, 80)}`,
      );
    }
    if (kind === "file") {
      if (expandedBytes > budgets.maxMemberBytes) {
        throw new ZipPolicyError(
          ErrorCode.ARCHIVE_LIMIT,
          `Archive member exceeds per-member budget: ${normalized.slice(0, 80)}`,
        );
      }
      expandedTotal += expandedBytes;
      if (expandedTotal > budgets.maxExpandedBytes) {
        throw new ZipPolicyError(
          ErrorCode.ARCHIVE_LIMIT,
          `Archive exceeds expanded size budget (${budgets.maxExpandedBytes} bytes)`,
        );
      }
      if (
        expandedBytes > RATIO_FLOOR_BYTES &&
        compressedBytes > 0 &&
        expandedBytes / compressedBytes > budgets.maxRatio
      ) {
        throw new ZipPolicyError(
          ErrorCode.ARCHIVE_LIMIT,
          `Archive member exceeds compression ratio limit (${budgets.maxRatio})`,
        );
      }
      inputTotal += compressedBytes;
    }
    members.push({
      path: normalized,
      kind,
      compressedBytes,
      expandedBytes,
      method: method as 0 | 8,
      flags,
      localHeaderOffset,
      externalAttrs,
      rawName: Buffer.from(rawName),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return { members, complete: true, entryCount: members.length, inputBytes: inputTotal, expandedBytes: expandedTotal };
}

/** 阶段一：解析 manifest 并完成全部成员校验（零写入） */
export async function readManifest(
  archiveReal: string,
  budgets: ArchiveBudgets = getArchiveBudgets(),
): Promise<ZipResult<ZipManifest>> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(archiveReal, "r");
    const stat = await handle.stat();
    const manifest = await readManifestImpl(handle, stat.size, budgets);
    return { ok: true, value: manifest };
  } catch (e) {
    return { ok: false, result: mapZipError(e) };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function mapZipError(e: unknown): ToolResult {
  if (e instanceof ZipPolicyError) {
    return zipFail(e.code, e.message, { retryable: false });
  }
  const message = e instanceof Error ? e.message : String(e);
  return zipFail(ErrorCode.ARCHIVE_FAILED, `Archive operation failed: ${message}`, { retryable: true });
}

// ====================================================================
// 阶段二：staging 解压（实时计数）
// ====================================================================

export interface ExtractOutcome {
  extracted: number;
  bytes: number;
}

async function extractMember(
  handle: fs.FileHandle,
  fileSize: number,
  member: ZipMember,
  stagingRoot: string,
  budgets: ArchiveBudgets,
  totals: { bytes: number },
): Promise<void> {
  const localHeader = Buffer.alloc(30);
  const read = await handle.read(localHeader, 0, 30, member.localHeaderOffset);
  if (read.bytesRead < 30 || readU32(localHeader, 0) !== LOCAL_SIG) {
    throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive local header is corrupt");
  }
  const localNameLen = readU16(localHeader, 26);
  const localExtraLen = readU16(localHeader, 28);
  const localName = Buffer.alloc(localNameLen);
  await handle.read(localName, 0, localNameLen, member.localHeaderOffset + 30);
  if (!localName.equals(member.rawName)) {
    throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive local header does not match central directory");
  }
  const dataOffset = member.localHeaderOffset + 30 + localNameLen + localExtraLen;
  if (dataOffset + member.compressedBytes > fileSize) {
    throw new ZipPolicyError(ErrorCode.ARCHIVE_FAILED, "Archive entry data is out of bounds");
  }

  const target = path.join(stagingRoot, member.path);
  const compressed = Buffer.alloc(member.compressedBytes);
  await handle.read(compressed, 0, member.compressedBytes, dataOffset);

  let memberBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
      try {
        memberBytes += chunk.length;
        totals.bytes += chunk.length;
        if (memberBytes > budgets.maxMemberBytes) {
          throw new ZipPolicyError(
            ErrorCode.ARCHIVE_LIMIT,
            `Archive member exceeds per-member budget during extraction: ${member.path.slice(0, 80)}`,
          );
        }
        if (totals.bytes > budgets.maxExpandedBytes) {
          throw new ZipPolicyError(
            ErrorCode.ARCHIVE_LIMIT,
            `Archive exceeds expanded size budget during extraction (${budgets.maxExpandedBytes} bytes)`,
          );
        }
        cb(null, chunk);
      } catch (e) {
        cb(e as Error);
      }
    },
  });

  const targetHandle = await fs.open(target, "wx", 0o600);
  try {
    const source = Readable.from(compressed, { objectMode: false });
    const inflater = member.method === 8 ? zlib.createInflateRaw() : undefined;
    if (inflater) {
      await pipeline(source, inflater, counter, targetHandle.createWriteStream());
    } else {
      await pipeline(source, counter, targetHandle.createWriteStream());
    }
  } finally {
    await targetHandle.close().catch(() => {});
  }
}

/**
 * 阶段二：向 outputReal 内的 staging 目录解压全部成员（实时计数），
 * 成功后逐项 rename 落位（目标已存在则先删，对齐 -Force 语义），失败清理 staging。
 */
export async function extractArchive(
  manifest: ZipManifest,
  archiveReal: string,
  outputReal: string,
  budgets: ArchiveBudgets = getArchiveBudgets(),
  signal?: AbortSignal,
): Promise<ZipResult<ExtractOutcome>> {
  const staging = path.join(outputReal, `.etmcp-extract-${process.pid}-${Date.now()}`);
  let handle: fs.FileHandle | null = null;
  const totals = { bytes: 0 };
  try {
    handle = await fs.open(archiveReal, "r");
    const stat = await handle.stat();
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    let extracted = 0;
    for (const member of manifest.members) {
      if (signal?.aborted) throw new ZipPolicyError(ErrorCode.CANCELLED, "Extract cancelled");
      const target = path.join(staging, member.path);
      // 双保险：校验过的路径拼接后必须仍在 staging 内
      const resolved = path.resolve(target);
      if (resolved !== staging && !resolved.startsWith(staging + path.sep)) {
        throw new ZipPolicyError(
          ErrorCode.ARCHIVE_LIMIT,
          `Archive member escapes output directory: ${member.path.slice(0, 80)}`,
        );
      }
      if (member.kind === "directory") {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await extractMember(handle, stat.size, member, staging, budgets, totals);
      extracted++;
    }

    // 落位：staging 顶层条目逐个 rename 到 outputReal（-Force 语义）
    const topLevel = await fs.readdir(staging);
    for (const entry of topLevel) {
      const dest = path.join(outputReal, entry);
      await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
      await fs.rename(path.join(staging, entry), dest);
    }
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    return { ok: true, value: { extracted, bytes: totals.bytes } };
  } catch (e) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (signal?.aborted) {
      return { ok: false, result: zipFail(ErrorCode.CANCELLED, "Extract cancelled", { retryable: true }) };
    }
    return { ok: false, result: mapZipError(e) };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
