/**
 * 内容安全扫描 — write_file / 缓存 / 可选读路径
 *
 * MCP_SECRETS_SCAN 分级：
 * - off: 永不扫描（scanContent 恒 safe）
 * - write: 仅写路径应调用（默认语义由调用方决定；本函数仍扫描，调用方按 tier 跳过）
 * - cache: 写 + 缓存路径扫描（默认）
 * - strict: 写 + 缓存 + 读路径可拒绝返回
 *
 * pattern 定义唯一来源在 secret-registry.ts（命令输出流式 matcher 同源），此处只做 whole-string 判定。
 */
import { SECRET_PATTERNS } from "./secret-registry.js";

export interface ScanResult {
  safe: boolean;
  findings: string[];
  /** 实际扫描是否覆盖全部输入；false 时消费方不得把结果视为"已证明安全" */
  complete: boolean;
  /** 实际参与扫描的字节数 */
  scannedBytes: number;
}

export type SecretsScanTier = "off" | "write" | "cache" | "strict";

/** 超过此字节数只扫描前缀（complete=false），避免大文件顺序正则 / 轻度 ReDoS */
export const SCAN_CONTENT_MAX_BYTES = 4 * 1024 * 1024;

export function getSecretsScanTier(): SecretsScanTier {
  const raw = (process.env.MCP_SECRETS_SCAN || "cache").toLowerCase().trim();
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "write") return "write";
  if (raw === "strict") return "strict";
  return "cache";
}

/** 写路径是否应扫描（off 除外） */
export function shouldScanOnWrite(): boolean {
  return getSecretsScanTier() !== "off";
}

/** 缓存路径是否应扫描（cache / strict） */
export function shouldScanOnCache(): boolean {
  const t = getSecretsScanTier();
  return t === "cache" || t === "strict";
}

/** 读路径是否应在发现密钥时拒绝返回（仅 strict） */
export function shouldBlockSecretReads(): boolean {
  return getSecretsScanTier() === "strict";
}

/**
 * 扫描内容是否含凭据/密钥
 * - tier=off：不做扫描（调用方经 shouldScan* 门控，不得依赖扫描结果）
 * - 超 4MiB：扫描 UTF-8 前缀并返回 complete=false（不再无条件视为 safe；strict 消费方据此 fail-closed）
 */
export function scanContent(content: string): ScanResult {
  if (getSecretsScanTier() === "off") {
    return { safe: true, findings: [], complete: false, scannedBytes: 0 };
  }
  let text = content;
  let complete = true;
  if (Buffer.byteLength(content, "utf-8") > SCAN_CONTENT_MAX_BYTES) {
    complete = false;
    text = truncateToByteLimit(content, SCAN_CONTENT_MAX_BYTES);
  }
  const findings: string[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) {
      findings.push(name);
    }
  }
  return { safe: findings.length === 0, findings, complete, scannedBytes: Buffer.byteLength(text, "utf-8") };
}

/** 二分求"UTF-8 字节数不超 limit 的最长前缀"（字符串级截断，不依赖半截多字节序列） */
function truncateToByteLimit(content: string, limit: number): string {
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(content.slice(0, mid), "utf-8") <= limit) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return content.slice(0, lo);
}
