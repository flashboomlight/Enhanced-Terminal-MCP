// src/security.ts — 安全基础层：路径穿越检测、命令注入防护、危险路径/敏感文件黑名单

import * as fs from "node:fs/promises";
import { platform } from "node:os";
import * as path from "node:path";
import { audit } from "./audit.js";
import { logger } from "./logger.js";

// 平台检测（内联，避免与 platform.ts 循环依赖）
const _IS_WIN = platform() === "win32";

// 禁止操作的系统关键路径 —— 相对于系统盘（按 %SystemRoot%/SystemDrive 动态识别）
// 仅列出盘符下的相对路径，运行时拼上实际系统盘
const FORBIDDEN_PATH_REL_WIN = [
  "\\Windows",
  "\\Windows.old",
  "\\Program Files",
  "\\Program Files (x86)",
  "\\ProgramData",
  "\\$Recycle.Bin",
  "\\System Volume Information",
  "\\Boot",
];

/** 取得 Windows 系统盘盘符（如 "C:"），失败回退 C: */
function getSystemDrive(): string {
  const sysRoot = process.env.SYSTEMROOT || process.env.SystemRoot;
  if (sysRoot && /^[A-Za-z]:[\\/]/.test(sysRoot)) {
    return sysRoot.slice(0, 2); // "C:"
  }
  const drive = process.env.SystemDrive;
  if (drive && /^[A-Za-z]:$/.test(drive)) return drive;
  return "C:";
}

/** 动态生成 Windows 禁止路径：拼上实际系统盘 */
function getForbiddenPathsWin(): string[] {
  const drive = getSystemDrive();
  return FORBIDDEN_PATH_REL_WIN.map((rel) => `${drive}${rel}`);
}

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
  return _IS_WIN ? getForbiddenPathsWin() : FORBIDDEN_PATHS_UNIX;
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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("security", "resolve-failed", `path.resolve failed for "${inputPath}": ${msg}`);
  }
  return p;
}

/**
 * 路径穿越检测
 * - 拦截 URL 编码绕过（单/双/三层编码 + overlong UTF-8）
 * - resolve 后若仍含 ".." 段则拦截
 */
export function isPathTraversal(inputPath: string): boolean {
  // 多层 URL 解码后检查 ".." / 分隔符（覆盖半编码、双层、三层、overlong 等）
  let decoded = inputPath;
  for (let i = 0; i < 4; i++) {
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(decoded) || decoded.split(/[\\/]/).some((s) => s === "..")) {
      return true;
    }
    // 半编码：..%2f / %2e%2e / %2e. / .%2e 等
    if (/\.\.%2[fF]|%2[eE]%2[eE]|%2[eE]\.|.%2[eE]|%2[fF]\.\.|%c0%ae|%c0%af|%e0%80%ae/i.test(decoded)) {
      return true;
    }
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, "%2B"));
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
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
 * 对已通过 validatePath 的路径再做 symlink 解析二次校验。
 * 用于写/删/移动等会真正落盘的操作 —— 攻击者可能用 symlink 指向系统目录绕过前缀匹配。
 * 不存在的路径解析失败视为安全（交给后续操作的自然 ENOENT）。
 * 返回错误消息或 null（安全）。
 */
export async function validateRealPath(targetPath: string, operation: string): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(targetPath);
  } catch {
    // 路径不存在或无法解析 —— 交给实际操作的 ENOENT，这里放行
    return null;
  }
  // 把规范化应用在真实路径上，再走一遍 forbidden/sensitive 检查
  if (isForbiddenPath(real)) {
    audit.record({
      action: "safety.block",
      detail: { operation, reason: "symlink to forbidden path", path: targetPath, real },
      success: false,
      error: "Symlink to forbidden path",
    });
    return `Operation '${operation}' blocked: path resolves via symlink to a protected system directory: ${targetPath} -> ${real}`;
  }
  if (isSensitivePath(real)) {
    audit.record({
      action: "safety.block",
      detail: { operation, reason: "symlink to sensitive path", path: targetPath, real },
      success: false,
      error: "Symlink to sensitive path",
    });
    return `Operation '${operation}' blocked: path resolves via symlink to sensitive data: ${targetPath} -> ${real}`;
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
  // 间接执行绕过补充
  // find -exec / -execdir 调用 rm
  /\bfind\s+.*-exec(?:dir)?\s+rm\s+/i,
  // sh -c / bash -c 后跟 rm -rf
  /\b(?:sh|bash|zsh|dash)\s+-c\s+.*\brm\s+-[a-zA-Z]*[rRfF]/i,
  // 解释器执行系统命令（python -c "import os; os.system(...)"）
  /\bpython(?:3)?\s+-c\s+.*(?:os\.system|subprocess\.(?:call|run|Popen))\b/i,
  // base64 / hex 解码后管道进 shell
  /\b(?:base64|xxd)\s+.*\|\s*(?:sh|bash|sh\s+-c|bash\s+-c)\b/i,
];

export function hasDangerousPattern(cmd: string): string | null {
  for (const p of DANGEROUS_PATTERNS) {
    if (p.test(cmd)) return p.source;
  }
  return null;
}

/**
 * 灾难性命令硬底线 —— 不可关闭，所有安全模式（含 off）下均拦截
 *
 * 与 hasDangerousPattern 的区别：
 * - hasDangerousPattern 是 best-effort 黑名单，覆盖面广但可被绕过，仅在 off/normal 模式生效
 * - hardBlock 只覆盖极少数真正灾难性的模式（删根/格式化/写裸设备/fork bomb），
 *   作为 off 模式关闭 guardDestructiveAction 后的最低底线
 *
 * 不追求完备（仍可被高阶绕过），只确保"明面上的灾难性命令在 off 模式不能无阻碍执行"
 */
const HARD_BLOCK_PATTERNS: RegExp[] = [
  // rm -rf 指向根 / home / 通配全删
  /\brm\s+-[a-zA-Z]*[rRfF][a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~|\$HOME\b|\.\s*$|\*\s*$)/i,
  // rm -rf 指向关键系统目录（/usr /etc /home /bin /sbin /var /lib /opt /root /boot /srv）
  // 允许可选引号包裹路径，覆盖 "$HOME" / ${HOME} / /usr 形态
  /\brm\s+-[a-zA-Z]*[rRfF][a-zA-Z]*\s+["'${]*(?:\/(?:usr|etc|home|bin|sbin|var|lib|opt|root|boot|srv|run|libx?32)\b|\$HOME\b|\$\{HOME\})/i,
  /\brm\s+--(?:no-preserve-root|recursive|force)/i,
  // rm -rf 经变量展开指向根（X=/; rm -rf $X 或 rm -rf $X/... 形态）
  /\brm\s+-[a-zA-Z]*[rRfF][a-zA-Z]*\s+\$\w+/i,
  // 格式化 / 写裸设备
  /\bformat\s+[a-zA-Z]:/i,
  /\bmkfs\./i,
  /\bdd\s+[^|]*of=\/dev\/(?:sd|hd|nvme|mmcblk|vd|xvd)/i,
  />\s*\/dev\/(?:sd|hd|nvme|mmcblk|vd|xvd)/i,
  // 其它写裸设备 / 全盘破坏
  /\b(?:shred|wipefs|badblocks)\s+.*\/dev\/(?:sd|hd|nvme|mmcblk|vd|xvd)/i,
  /\bfind\s+\/\s+.*(?:-delete|-exec\s+rm\b|-execdir\s+rm\b)/i,
  /\b(?:mv|cp)\s+\/\s+.*\/dev\/null/i,
  // fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // 关机 / 重启
  /\bshutdown\s+(?:-|\/)/i,
  /\b(?:halt|poweroff|reboot)\s+-/i,
  // chmod 777 全盘
  /\bchmod\s+-R\s+0*777\s+\//i,
];

export function hardBlock(cmd: string): string | null {
  for (const p of HARD_BLOCK_PATTERNS) {
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
