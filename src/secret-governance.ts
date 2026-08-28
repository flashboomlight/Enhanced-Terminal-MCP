/**
 * SecretGovernance — 统一 redactor + env policy（production-hardening 模块 E / roadmap §5.5 契约）
 *
 * - pattern 唯一来源仍是 secret-registry.ts：本模块只做 g-flag 克隆与替换，不复制定义，
 *   也不触碰流式 matcher（secret-stream.ts）使用的原 regex 对象。
 * - 依赖纪律：运行时只 import secret-registry（result 仅 type import、不导入 logger），
 *   保证 result → secret-governance → secret-registry 无模块加载期循环；
 *   配置告警由消费方经 getEnvValueMode() 的 warning 字段输出。
 * - 执行链红线：redaction 只作用于展示/记录/持久化出口，绝不修改将被执行或写盘的数据。
 */

import type { StructuredError } from "./result.js";
import { SECRET_PATTERNS } from "./secret-registry.js";

export const REDACTED = "[REDACTED]";

/** g-flag 克隆：whole-string 命中检测的 regex 无 g flag，替换需要独立对象避免 lastIndex 污染 */
const REDACT_RULES: RegExp[] = SECRET_PATTERNS.map(
  ({ regex }) => new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`),
);

/** URL userinfo 凭据：scheme://user:pass@ → scheme://user:[REDACTED]@（redactor-only，不入流式 registry） */
const URL_CREDENTIALS_REGEX = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

/** 对文本做已注册 secret pattern + URL userinfo 替换；只处理已注册模式 */
export function redactText(text: string): string {
  let out = typeof text === "string" ? text : "";
  URL_CREDENTIALS_REGEX.lastIndex = 0;
  out = out.replace(URL_CREDENTIALS_REGEX, (_match, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`);
  for (const regex of REDACT_RULES) {
    regex.lastIndex = 0;
    out = out.replace(regex, REDACTED);
  }
  return out;
}

/** 按字符数截断（code point 口径，与 boundedString 一致），超限尾部加省略号 */
function capCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const points = Array.from(text);
  return points.length <= maxChars ? text : `${points.slice(0, maxChars).join("")}…`;
}

/** redact + code point 截断：命令在 audit/history/prompt 等出口的统一形态 */
export function redactCommand(command: string, maxChars = 2000): string {
  return capCodePoints(redactText(command ?? ""), maxChars);
}

const CONTROL_ESCAPES: Record<string, string> = { "\r": "\\r", "\n": "\\n", "\t": "\\t" };

/** 控制字符转义（\r \n \t 用可读转义，其余 C0/DEL 用 \xNN），防 log forging */
function escapeControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const readable = CONTROL_ESCAPES[ch];
    if (readable !== undefined) {
      out += readable;
      continue;
    }
    const code = ch.charCodeAt(0);
    out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
  }
  return out;
}

/** UTF-8 字节上限截断，超限尾部加 "..." */
function capBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  let out = text;
  while (out.length > 0 && Buffer.byteLength(`${out}...`, "utf-8") > maxBytes) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

/**
 * 日志字段净化：String 化 → 控制字符转义 → redact → UTF-8 字节截断。
 * logger / audit error / prompt / fatal 的统一入口。
 */
export function sanitizeLogField(value: unknown, maxBytes = 2000): string {
  const raw = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return capBytes(redactText(escapeControl(raw)), maxBytes);
}

export interface RedactDetailOptions {
  /** 序列化后的总字节上限，超过整体替换为 { truncated: true } */
  maxBytes?: number;
  /** 单个字符串值的字符上限 */
  maxStringChars?: number;
  /** 递归深度与集合条目上限 */
  maxDepth?: number;
  maxEntries?: number;
}

/** detail JSON 走访：字符串逐个 redact + 截断；整体超限降级为 { truncated: true } */
export function redactDetail(detail: unknown, opts: RedactDetailOptions = {}): unknown {
  const { maxBytes = 8192, maxStringChars = 1024, maxDepth = 6, maxEntries = 100 } = opts;
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return capCodePoints(redactText(value), maxStringChars);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Error)
      return { name: value.name, message: capCodePoints(redactText(value.message), maxStringChars) };
    if (depth >= maxDepth) return "[truncated]";
    if (Array.isArray(value)) return value.slice(0, maxEntries).map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, maxEntries)) {
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  try {
    const walked = walk(detail, 0);
    const json = JSON.stringify(walked);
    if (json === undefined || Buffer.byteLength(json, "utf-8") > maxBytes) return { truncated: true };
    return walked;
  } catch {
    return { truncated: true };
  }
}

/** 未知异常 → 脱敏后的结构化错误（fatal stderr 与后续 wrapper 兜底复用） */
export function redactError(error: unknown, code: StructuredError["code"] = "INTERNAL_ERROR"): StructuredError {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return {
    code,
    message: sanitizeLogField(message, 2000),
    retryable: false,
    detail: error instanceof Error ? { name: error.name } : redactDetail(error),
  };
}

// ====================================================================
// env policy —— key 判定一律大小写规范化（Windows 环境变量不区分大小写）
// ====================================================================

/** 持久化/注入 deny 集合：成员与既有 FORBIDDEN_ENV_KEYS 一致，判定改为规范化大小写 */
const DENIED_ENV_KEYS: ReadonlySet<string> = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PSMODULEPATH",
  "SYSTEMROOT",
  "COMSPEC",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

/** env key 规范化形式（判定与 allowlist 匹配的统一口径） */
export function normalizeEnvKey(key: string): string {
  return key.toUpperCase();
}

/** key 是否在持久化/注入 deny 集合（大小写不敏感；path/node_options 变体命中） */
export function isDeniedEnvKey(key: string): boolean {
  return DENIED_ENV_KEYS.has(normalizeEnvKey(key));
}

/** env key 策略：形状（非空、无 =、≤256）+ deny；返回错误消息或 null */
export function validateEnvKeyPolicy(key: string): string | null {
  if (typeof key !== "string" || !key.trim() || key.includes("=") || key.length > 256) {
    return "invalid env key";
  }
  if (isDeniedEnvKey(key)) {
    return `env key "${key}" is denied for session persistence/injection`;
  }
  return null;
}

/** 敏感 env key 关键词（自 system.ts 收编，唯一来源移到本模块） */
export const SENSITIVE_ENV_KEYWORDS =
  /(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|PRIVATE_?KEY|CREDENTIAL|ENCRYPTION|PSW|JWT|OAUTH|CERT|LICENSE_KEY|DB_PASS)/i;

export type EnvValueMode = "allowlist" | "full" | "keys";

/** 内建非敏感值展示白名单（大小写不敏感精确匹配） */
const DEFAULT_ENV_VALUE_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "OS",
  "USERNAME",
  "USER",
  "SHELL",
  "TERM",
  "PWD",
  "COMPUTERNAME",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "EDITOR",
  "VISUAL",
]);

/** MCP_ENV_VALUE_MODE 解析：非法值回落 allowlist，warning 由消费方输出（本模块不导入 logger） */
export function getEnvValueMode(): { mode: EnvValueMode; warning?: string } {
  const raw = (process.env.MCP_ENV_VALUE_MODE || "allowlist").toLowerCase().trim();
  if (raw === "allowlist" || raw === "full" || raw === "keys") return { mode: raw };
  return { mode: "allowlist", warning: `Unknown MCP_ENV_VALUE_MODE="${raw}", using "allowlist"` };
}

/** MCP_ENV_VALUE_ALLOWLIST 的逗号分隔补充项（精确名匹配，非 regex，避免配置注入） */
function getExtraEnvValueAllowlist(): ReadonlySet<string> {
  const raw = process.env.MCP_ENV_VALUE_ALLOWLIST || "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0),
  );
}

/** environment_vars 值展示策略：sensitive 恒掩码；否则按 mode 判定 */
export function envValueDisplayAllowed(key: string): boolean {
  if (SENSITIVE_ENV_KEYWORDS.test(key)) return false;
  const { mode } = getEnvValueMode();
  if (mode === "full") return true;
  if (mode === "keys") return false;
  const normalized = normalizeEnvKey(key);
  return DEFAULT_ENV_VALUE_ALLOWLIST.has(normalized) || getExtraEnvValueAllowlist().has(normalized);
}

/** session 持久化 env value 的 opt-in 策略：显式开启且非 denied/非 sensitive */
export function persistentEnvValueAllowed(key: string): boolean {
  if (isDeniedEnvKey(key) || SENSITIVE_ENV_KEYWORDS.test(key)) return false;
  const raw = (process.env.MCP_SESSION_PERSIST_ENV_VALUES || "0").toLowerCase().trim();
  return raw === "1" || raw === "true";
}
