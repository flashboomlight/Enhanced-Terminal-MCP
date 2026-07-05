// src/security.ts — 安全基础层：路径穿越检测、命令注入防护、危险路径/敏感文件黑名单

import { platform } from "node:os";
import * as path from "node:path";
import { audit } from "./audit.js";
import { logger } from "./logger.js";

// 平台检测（内联，避免与 platform.ts 循环依赖）
const _IS_WIN = platform() === "win32";

// 禁止操作的系统关键路径
const FORBIDDEN_PATHS_WIN = [
  "C:\\Windows",
  "C:\\Windows.old",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "C:\\$Recycle.Bin",
  "C:\\System Volume Information",
  "C:\\Boot",
];
const FORBIDDEN_PATHS_UNIX = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/lib",
  "/usr/libexec",
  "/boot",
  "/etc",
  "/proc",
  "/sys",
  "/dev",
];

// 敏感文件名 / 扩展名（密钥、凭据、环境变量等）
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..+)?$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
  /(^|[\\/])\.netrc$/i,
  /(^|[\\/])\.git-credentials$/i,
  /(^|[\\/])id_[a-z0-9]+$/i, // SSH private keys (不含 .pub)
  /(^|[\\/])known_hosts$/i,
  /(^|[\\/])authorized_keys$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.key$/i,
  /\.keystore$/i,
  /\.jks$/i,
  /(^|[\\/])(shadow|gshadow|passwd|sudoers)$/i,
  /(^|[\\/])kubeconfig$/i,
];

// 敏感目录前缀
const SENSITIVE_DIR_PATTERNS_WIN: RegExp[] = [
  /\\AppData\\Roaming\\Microsoft\\Credentials\b/i,
  /\\AppData\\Local\\Microsoft\\Credentials\b/i,
  /\\AppData\\Roaming\\Microsoft\\Crypto\b/i,
  /\\\.ssh(\\|$)/i,
  /\\\.aws(\\|$)/i,
  /\\\.azure(\\|$)/i,
  /\\\.kube(\\|$)/i,
  /\\\.gnupg(\\|$)/i,
  /\\\.docker\\config\.json$/i,
];
const SENSITIVE_DIR_PATTERNS_UNIX: RegExp[] = [
  /\/\.ssh(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.azure(\/|$)/,
  /\/\.kube(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/\.config\/gh(\/|$)/,
  /\/\.docker\/config\.json$/,
];

export function getForbiddenPaths(): string[] {
  return _IS_WIN ? FORBIDDEN_PATHS_WIN : FORBIDDEN_PATHS_UNIX;
}

/**
 * 规范化路径：解析为绝对路径，去除 Windows 设备前缀 \\?\
 */
export function normalizePath(inputPath: string): string {
  let p = inputPath.trim();
  if (_IS_WIN) {
    p = p.replace(/^\\\\\?\\(UNC\\)?/, (_, unc) => (unc ? "\\\\" : ""));
  }
  try {
    p = path.resolve(p);
  } catch (e: any) {
    logger.warn("security", "resolve-failed", `path.resolve failed for "${inputPath}": ${e.message}`);
  }
  return p;
}

/**
 * 路径穿越检测
 * - 拦截 URL 编码绕过（单/双/三层编码 + overlong UTF-8）
 * - resolve 后若仍含 ".." 段则拦截
 */
export function isPathTraversal(inputPath: string): boolean {
  // URL 编码绕过检测（含三层编码和 overlong UTF-8）
  if (/%2e%2e|%252e%252e|%25252e|%2f%2e|%252f%252e|%c0%ae|%c0%af|%e0%80%ae/i.test(inputPath)) return true;
  // 检查原始输入中的 ".." 段
  const segments = inputPath.split(/[\\/]/);
  if (segments.some((seg) => seg === "..")) return true;
  const resolved = normalizePath(inputPath);
  if (resolved.split(/[\\/]/).some((seg) => seg === "..")) return true;
  return false;
}

/**
 * 检查路径是否在禁止列表中（严格前缀匹配，须后跟分隔符或完全相等）
 */
export function isForbiddenPath(targetPath: string): boolean {
  const normalized = normalizePath(targetPath);
  const forbidden = getForbiddenPaths();
  const toCmp = (s: string) => (_IS_WIN ? s.toLowerCase() : s);
  const normCmp = toCmp(normalized);
  return forbidden.some((fp) => {
    const fpCmp = toCmp(fp);
    return normCmp === fpCmp || normCmp.startsWith(`${fpCmp}\\`) || normCmp.startsWith(`${fpCmp}/`);
  });
}

/**
 * 判断路径是否指向敏感文件或目录
 */
export function isSensitivePath(targetPath: string): boolean {
  const normalized = normalizePath(targetPath);
  const dirPatterns = _IS_WIN ? SENSITIVE_DIR_PATTERNS_WIN : SENSITIVE_DIR_PATTERNS_UNIX;
  if (dirPatterns.some((re) => re.test(normalized))) return true;
  if (SENSITIVE_FILE_PATTERNS.some((re) => re.test(normalized))) return true;
  return false;
}

/**
 * 校验路径安全性，返回错误消息或 null（安全）
 */
export function validatePath(targetPath: string, operation: string): string | null {
  if (!targetPath || targetPath.trim().length === 0) {
    return "Path cannot be empty";
  }
  if (isPathTraversal(targetPath)) {
    audit.record({
      action: "safety.block",
      detail: { operation, reason: "path traversal", path: targetPath },
      success: false,
      error: "Path traversal detected",
    });
    return `Path traversal detected in ${operation}: ${targetPath}`;
  }
  if (isForbiddenPath(targetPath)) {
    audit.record({
      action: "safety.block",
      detail: { operation, reason: "forbidden path", path: targetPath },
      success: false,
      error: "Forbidden path",
    });
    return `Operation '${operation}' blocked: path is in protected system directory: ${targetPath}`;
  }
  if (isSensitivePath(targetPath)) {
    audit.record({
      action: "safety.block",
      detail: { operation, reason: "sensitive path", path: targetPath },
      success: false,
      error: "Sensitive path",
    });
    return `Operation '${operation}' blocked: path contains sensitive data: ${targetPath}`;
  }
  return null;
}

/**
 * 危险命令模式（尽力而为的黑名单 — 不是唯一防线）
 * 覆盖：直接调用、分离 flag、eval/子shell 包裹、PowerShell 变体（含缩写）
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // rm -rf / (合并 flag)
  /\brm\s+-[a-zA-Z]*[rRfF][a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~|\$HOME)/i,
  // rm -r -f / (分离 flag)
  /\brm\s+(?:-[a-zA-Z]*\s+)*-[rR]\b.*\s+-[fF]\b.*\s+(?:\/(?:\s|$|\*)|~|\$HOME)/i,
  /\brm\s+(?:-[a-zA-Z]*\s+)*-[fF]\b.*\s+-[rR]\b.*\s+(?:\/(?:\s|$|\*)|~|\$HOME)/i,
  // rm --recursive --force /
  /\brm\s+--(?:recursive|force)\s+--(?:recursive|force)\s+(?:\/(?:\s|$|\*)|~|\$HOME)/i,
  /\brm\s+--no-preserve-root/i,
  /\brmdir\s+\/[sS]\s+\/[qQ]\s+[a-zA-Z]:[\\/]/i,
  /\brd\s+\/[sS]\s+\/[qQ]\s+[a-zA-Z]:[\\/]/i,
  /\bdel\s+\/[sS]\s+\/[qQ]\s+[a-zA-Z]:[\\/]/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bmkfs\./i,
  /\bdd\s+[^|]*of=\/dev\/(?:sd|hd|nvme|mmcblk|vd|xvd)/i,
  />\s*\/dev\/(?:sd|hd|nvme|mmcblk|vd|xvd)/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bshutdown\s+(?:-|\/)/i,
  /\b(?:halt|poweroff|reboot)\s+-/i,
  /\bchmod\s+-R\s+0*777\s+\//i,
  // eval/子shell 包裹的危险命令
  /\beval\s+.*\brm\s+-[a-zA-Z]*[rRfF]/i,
  /\$\(.*\brm\s+-[a-zA-Z]*[rRfF]/i,
  /`.*\brm\s+-[a-zA-Z]*[rRfF]/i,
  // PowerShell 危险命令（含缩写参数 -r, -fo, -rec）
  /\bRemove-Item\s+.*-(?:Recurse|rec|r)\b.*-(?:Force|fo)\b.*[a-zA-Z]:[\\/]/i,
  /\bRemove-Item\s+.*-(?:Force|fo)\b.*-(?:Recurse|rec|r)\b.*[a-zA-Z]:[\\/]/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
];

export function hasDangerousPattern(cmd: string): string | null {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(cmd)) return p.source;
  }
  return null;
}

/**
 * 对进程名做输入消毒：只保留字母数字和 . - _（不允许通配符 *）
 */
export function sanitizeProcessName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, "");
}

/**
 * 校验 URL 的协议白名单，返回错误消息或 null
 */
export function validateUrl(url: string): string | null {
  if (!url || url.trim().length === 0) return "URL cannot be empty";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    logger.debug("security", "url-parse-failed", String(err));
    return `Invalid URL: ${url}`;
  }
  const allowed = new Set(["http:", "https:"]);
  if (!allowed.has(parsed.protocol)) {
    return `URL protocol '${parsed.protocol}' not allowed (only http/https)`;
  }
  return null;
}

/**
 * 校验 ping/dns 的 target 主机名：只允许字母数字、点、连字符、冒号（IPv6）
 */
export function validateHost(host: string): string | null {
  if (!host || host.trim().length === 0) return "Host cannot be empty";
  if (host.length > 253) return "Host too long";
  if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    return `Host contains invalid characters: ${host}`;
  }
  return null;
}
