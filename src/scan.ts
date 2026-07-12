/**
 * 内容安全扫描 — write_file 前检测凭据/密钥泄露
 */
export interface ScanResult {
  safe: boolean;
  findings: string[];
}

/** 超过此字节数跳过扫描，避免大文件顺序正则 / 轻度 ReDoS */
export const SCAN_CONTENT_MAX_BYTES = 4 * 1024 * 1024;

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // OpenAI：经典 sk- 长串或 sk-proj-；避免 sk-test-key-... 类文档假阳性
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
  // 用户/密码段限长，避免 [^:]+ / [^@]+ 对无 @ 长行回溯
  {
    name: "Connection String",
    regex: /(?:mongodb|mysql|postgres|redis):\/\/[^:\s]{1,128}:[^@\s]{1,128}@(?!localhost|127\.0\.0\.1)[^\s]{1,256}/i,
  },
  { name: "Discord Token", regex: /\b[MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/ },
];

/**
 * 扫描内容是否含凭据/密钥；超大内容直接视为 safe（调用方应另做大小限制）
 */
export function scanContent(content: string): ScanResult {
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
