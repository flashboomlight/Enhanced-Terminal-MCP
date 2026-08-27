/**
 * 分页缓存索引格式 — 版本化 stdout.idx 编解码、构建与 checkpoint 定位
 *
 * 从 paging.ts 拆出（2026-08-28 structural-debt-cleanup R2）；二进制格式常量收敛在本模块。
 */

import * as fs from "node:fs/promises";
import { type PageEncoding, readUnit } from "./codec.js";
import { PageCacheCorruptError } from "./errors.js";

export interface IndexRecord {
  charOffset: bigint;
  byteOffset: bigint;
}

const INDEX_MAGIC = Buffer.from("ETMCPIDX", "ascii");
const INDEX_VERSION = 1;
const INDEX_HEADER_BYTES = 16;
const INDEX_RECORD_BYTES = 16;
export const INDEX_STRIDE_CHARS = 1024;

/** 扫描正文并生成 code point 到 byte 的检查点 */
export function buildIndex(
  data: Buffer,
  encoding: PageEncoding,
  dataStart: number,
): { records: IndexRecord[]; totalChars: number } {
  const records: IndexRecord[] = [{ charOffset: 0n, byteOffset: BigInt(dataStart) }];
  let offset = dataStart;
  let totalChars = 0;
  while (offset < data.length) {
    const unit = readUnit(data, offset, encoding);
    const count = Array.from(unit.text).length;
    for (let i = 0; i < count; i++) {
      totalChars++;
      if (totalChars % INDEX_STRIDE_CHARS === 0) {
        records.push({ charOffset: BigInt(totalChars), byteOffset: BigInt(unit.next) });
      }
    }
    offset = unit.next;
  }
  if (totalChars > 0 && records[records.length - 1].charOffset !== BigInt(totalChars)) {
    records.push({ charOffset: BigInt(totalChars), byteOffset: BigInt(data.length) });
  }
  return { records, totalChars };
}

/** 将检查点编码为固定 16 字节记录的二进制索引 */
export function encodeIndex(encoding: PageEncoding, records: IndexRecord[]): Buffer {
  const output = Buffer.alloc(INDEX_HEADER_BYTES + records.length * INDEX_RECORD_BYTES);
  INDEX_MAGIC.copy(output, 0);
  output.writeUInt16LE(INDEX_VERSION, 8);
  output.writeUInt8(encoding === "utf8" ? 1 : 2, 10);
  output.writeUInt8(0, 11);
  output.writeUInt32LE(INDEX_STRIDE_CHARS, 12);
  records.forEach((record, index) => {
    const offset = INDEX_HEADER_BYTES + index * INDEX_RECORD_BYTES;
    output.writeBigUInt64LE(record.charOffset, offset);
    output.writeBigUInt64LE(record.byteOffset, offset + 8);
  });
  return output;
}

/** 读取并校验版本化 stdout 索引 */
export async function readIndex(
  file: string,
  expectedEncoding: PageEncoding,
  expectedBytes: number,
  expectedDataStart: number,
  expectedChars: number,
): Promise<IndexRecord[]> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (error) {
    throw new PageCacheCorruptError(`Cannot read stdout.idx: ${String(error)}`);
  }
  if (raw.length < INDEX_HEADER_BYTES || !raw.subarray(0, 8).equals(INDEX_MAGIC)) {
    throw new PageCacheCorruptError("Invalid stdout.idx header");
  }
  if (raw.readUInt16LE(8) !== INDEX_VERSION || raw.readUInt8(11) !== 0 || raw.readUInt32LE(12) !== INDEX_STRIDE_CHARS) {
    throw new PageCacheCorruptError("Unsupported stdout.idx version or flags");
  }
  const indexEncoding = raw.readUInt8(10) === 1 ? "utf8" : raw.readUInt8(10) === 2 ? "gbk" : null;
  if (indexEncoding !== expectedEncoding || (raw.length - INDEX_HEADER_BYTES) % INDEX_RECORD_BYTES !== 0) {
    throw new PageCacheCorruptError("stdout.idx encoding or record size mismatch");
  }
  const records: IndexRecord[] = [];
  for (let offset = INDEX_HEADER_BYTES; offset < raw.length; offset += INDEX_RECORD_BYTES) {
    const charOffset = raw.readBigUInt64LE(offset);
    const byteOffset = raw.readBigUInt64LE(offset + 8);
    if (charOffset > BigInt(Number.MAX_SAFE_INTEGER) || byteOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PageCacheCorruptError("stdout.idx offset exceeds safe integer range");
    }
    records.push({ charOffset, byteOffset });
  }
  if (records.length === 0 || records[0].charOffset !== 0n || records[0].byteOffset < 0n) {
    throw new PageCacheCorruptError("stdout.idx is missing its first checkpoint");
  }
  let previousChar = -1n;
  let previousByte = -1n;
  for (const record of records) {
    if (
      record.charOffset < previousChar ||
      record.byteOffset < previousByte ||
      record.byteOffset > BigInt(expectedBytes)
    ) {
      throw new PageCacheCorruptError("stdout.idx offsets are not monotonic");
    }
    previousChar = record.charOffset;
    previousByte = record.byteOffset;
  }
  const first = records[0];
  const last = records[records.length - 1];
  if (
    first.byteOffset !== BigInt(expectedDataStart) ||
    last.charOffset !== BigInt(expectedChars) ||
    last.byteOffset !== BigInt(expectedBytes)
  ) {
    throw new PageCacheCorruptError("stdout.idx sentinel does not match meta.json");
  }
  if (expectedChars === 0 && records.length !== 1) {
    throw new PageCacheCorruptError("Empty stdout must have one index record");
  }
  return records;
}

/** 从检查点中二分查找不超过目标字符位置的最近记录 */
export function findCheckpoint(records: IndexRecord[], target: number): IndexRecord {
  let low = 0;
  let high = records.length - 1;
  let best = records[0];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const record = records[middle];
    if (record.charOffset <= BigInt(target)) {
      best = record;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/** 从检查点中定位目标页结束位置 */
export function findEndByte(records: IndexRecord[], target: number, fallback: number): number {
  const next = records.find((record) => record.charOffset >= BigInt(target));
  return Number(next?.byteOffset ?? BigInt(fallback));
}
