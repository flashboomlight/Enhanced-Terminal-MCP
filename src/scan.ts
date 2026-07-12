/**
 * 内容安全扫描 — write_file 前检测凭据/密钥泄露
 */
export interface ScanResult {
  safe: boolean;
  findings: string[];
}

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "OpenAI API Key", regex: /sk-[A-Za-z0-9-_]{20,}/ },
  { name: "GitHub Token", regex: /gh[ps]_[A-Za-z0-9_]{20,}/ },
  { name: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: "AWS Secret Key",
    regex: /(?:aws_secret_access_key|secret_key|SecretAccessKey)\s*[:=]\s*["']?[0-9a-zA-Z/+]{40}["']?/i,
  },
  { name: "Private Key Header", regex: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/ },
  { name: "JWT Token", regex: /eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/ },
  { name: "Slack Token", regex: /xox[baprs]-[A-Za-z0-9-]+/ },
  { name: "Generic API Key", regex: /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{32,}["']?/i },
  { name: "Connection String", regex: /(?:mongodb|mysql|postgres|redis):\/\/[^:]+:[^@]+@(?!localhost|127\.0\.0\.1)/i },
  { name: "Discord Token", regex: /[MN][A-Za-z0-9]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}/ },
];

/**
 * 扫描内容是否含凭据/密钥
 */
export function scanContent(content: string): ScanResult {
  const findings: string[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
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
