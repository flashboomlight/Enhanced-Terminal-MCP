/**
 * 分页缓存字节编解码层 — UTF-8/GBK 单元解析、合法性与编码探测
 *
 * 从 paging.ts 拆出（2026-08-28 structural-debt-cleanup R2）；纯 Buffer 运算，无 IO。
 */

export type PageEncoding = "utf8" | "gbk";

export interface ByteUnit {
  text: string;
  next: number;
  valid: boolean;
}

const utf8Decoder = new TextDecoder("utf-8");
const gbkDecoder = new TextDecoder("gbk");

/** 解析一个 UTF-8 单元，同时标记是否为合法序列 */
function readUtf8Unit(data: Buffer, offset: number): ByteUnit {
  const first = data[offset];
  if (first <= 0x7f) return { text: String.fromCharCode(first), next: offset + 1, valid: true };
  const second = data[offset + 1];
  const third = data[offset + 2];
  const fourth = data[offset + 3];
  if (first >= 0xc2 && first <= 0xdf && second >= 0x80 && second <= 0xbf) {
    const codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
    return { text: String.fromCodePoint(codePoint), next: offset + 2, valid: true };
  }
  if (first >= 0xe0 && first <= 0xef && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf) {
    const canonical = first !== 0xe0 || second >= 0xa0;
    const nonSurrogate = first !== 0xed || second <= 0x9f;
    if (canonical && nonSurrogate) {
      const codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      return { text: String.fromCodePoint(codePoint), next: offset + 3, valid: true };
    }
  }
  if (
    first >= 0xf0 &&
    first <= 0xf4 &&
    second >= 0x80 &&
    second <= 0xbf &&
    third >= 0x80 &&
    third <= 0xbf &&
    fourth >= 0x80 &&
    fourth <= 0xbf
  ) {
    const canonical = first !== 0xf0 || second >= 0x90;
    const inRange = first !== 0xf4 || second <= 0x8f;
    if (canonical && inRange) {
      const codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      return { text: String.fromCodePoint(codePoint), next: offset + 4, valid: true };
    }
  }
  return { text: "�", next: offset + 1, valid: false };
}

/** 解析一个 GBK 单元，非法字节按 replacement character 计数 */
function readGbkUnit(data: Buffer, offset: number): ByteUnit {
  const first = data[offset];
  if (first <= 0x7f) return { text: String.fromCharCode(first), next: offset + 1, valid: true };
  const second = data[offset + 1];
  if (first >= 0x81 && first <= 0xfe && second >= 0x40 && second <= 0xfe && second !== 0x7f) {
    const text = gbkDecoder.decode(data.subarray(offset, offset + 2)) || "�";
    return { text, next: offset + 2, valid: text !== "�" };
  }
  const text = gbkDecoder.decode(data.subarray(offset, offset + 1)) || "�";
  return { text, next: offset + 1, valid: text !== "�" };
}

/** 按最终编码解析一个字节单元 */
export function readUnit(data: Buffer, offset: number, encoding: PageEncoding): ByteUnit {
  return encoding === "utf8" ? readUtf8Unit(data, offset) : readGbkUnit(data, offset);
}

/** 判断完整字节串是否为严格合法 UTF-8 */
function isValidUtf8(data: Buffer): boolean {
  let offset = 0;
  while (offset < data.length) {
    const unit = readUtf8Unit(data, offset);
    if (!unit.valid) return false;
    offset = unit.next;
  }
  return true;
}

/** 按平台规则判定编码并返回正文起始字节 */
export function detectEncoding(data: Buffer): { encoding: PageEncoding; dataStart: number } {
  const hasBom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  if (hasBom) return { encoding: "utf8", dataStart: 3 };
  if (process.platform === "win32" && !isValidUtf8(data)) return { encoding: "gbk", dataStart: 0 };
  return { encoding: "utf8", dataStart: 0 };
}

/** 解码完整字节单元，保留 chunk 末尾尚未完整到达的多字节序列 */
export function decodeCompleteUnits(data: Buffer, encoding: PageEncoding): { text: string; consumed: number } {
  let offset = 0;
  const parts: string[] = [];
  while (offset < data.length) {
    const first = data[offset];
    if (encoding === "utf8") {
      const expected =
        first <= 0x7f
          ? 1
          : first >= 0xc2 && first <= 0xdf
            ? 2
            : first >= 0xe0 && first <= 0xef
              ? 3
              : first >= 0xf0 && first <= 0xf4
                ? 4
                : 1;
      if (data.length - offset < expected) break;
    } else if (first >= 0x81 && first <= 0xfe && data.length - offset < 2) {
      break;
    }
    const unit = readUnit(data, offset, encoding);
    parts.push(unit.text);
    offset = unit.next;
  }
  return { text: parts.join(""), consumed: offset };
}

/** 返回指定编码下一个字节单元的理论长度，用于跨 chunk 保留尾部。 */
export function expectedUnitBytes(data: Buffer, offset: number, encoding: PageEncoding): number {
  const first = data[offset];
  if (encoding === "gbk") return first >= 0x81 && first <= 0xfe ? 2 : 1;
  if (first <= 0x7f) return 1;
  if (first >= 0xc2 && first <= 0xdf) return 2;
  if (first >= 0xe0 && first <= 0xef) return 3;
  if (first >= 0xf0 && first <= 0xf4) return 4;
  return 1;
}

export { gbkDecoder, utf8Decoder };
