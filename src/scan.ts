/**
 * 内容安全扫描 — write_file / 缓存 / 可选读路径
 *
 * MCP_SECRETS_SCAN 分级：
 * - off: 永不扫描（scanContent 恒 safe）
 * - write: 仅写路径应调用（默认语义由调用方决定；本函数仍扫描，调用方按 tier 跳过）
 * - cache: 写 + 缓存路径扫描（默认）
 * - strict: 写 + 缓存 + 读路径可拒绝返回
 */
export interface ScanResult {
  safe: boolean;
  findings: string[];
}

export type SecretsScanTier = "off" | "write" | "cache" | "strict";

/** 超过此字节数跳过扫描，避免大文件顺序正则 / 轻度 ReDoS */
export const SCAN_CONTENT_MAX_BYTES = 4 * 1024 * 1024;

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "OpenAI API Key", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: "GitHub Token", regex: /\bgh[ps]_[A-Za-z0-9_]{20,}\b/ },
  { name: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "AWS Secret Key",
    regex: /(?:aws_secret_access_key|secret_key|SecretAccessKey)\s*[:=]\s*["']?[0-9a-zA-Z/+]{40}["']?/i,
  },
  { name: "Private Key Header", regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/ },
  { name: "JWT Token", regex: /\beyJ[A-Za-z0-9-_=]{10,}\.[A-Za-z0-9-_=]{10,}\.?[A-Za-z0-9-_.+/=]*/ },
  { name: "Slack Token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Generic API Key", regex: /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{32,}["']?/i },
  {
    name: "Connection String",
    regex: /(?:mongodb|mysql|postgres|redis):\/\/[^:\s]{1,128}:[^@\s]{1,128}@(?!localhost|127\.0\.0\.1)[^\s]{1,256}/i,
  },
  { name: "Discord Token", regex: /\b[MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/ },
];

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
 * 扫描内容是否含凭据/密钥；tier=off 或超大内容视为 safe
 */
export function scanContent(content: string): ScanResult {
  if (getSecretsScanTier() === "off") {
    return { safe: true, findings: [] };
  }
  if (Buffer.byteLength(content, "utf-8") > SCAN_CONTENT_MAX_BYTES) {
    return { safe: true, findings: [] };
  }
  const findings: string[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(content)) {
      findings.push(name);
    }
  }
  return { safe: findings.length === 0, findings };
}

/**
 * 扫描文件路径是否敏感（委托给 security.ts 的统一实现）
 * @deprecated 使用 isSensitivePath from security.ts
 */
export { isSensitivePath as isCredentialFilePath } from "./security.js";
