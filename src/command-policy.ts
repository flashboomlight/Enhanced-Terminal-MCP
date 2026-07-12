/**
 * 命令策略：默认黑名单 + hardBlock；可选 allow 白名单（MCP_COMMAND_POLICY=allow）
 *
 * allow 模式：
 * 1) 始终先 hardBlock
 * 2) 拒绝 shell 控制元字符 / 管道 / 命令拼接（防 "npm test; curl evil"）
 * 3) 首个可执行词或整串前缀匹配 MCP_COMMAND_ALLOW（逗号分隔）或内置默认
 *
 * 非 allow 模式仍为 hasDangerousPattern 黑名单。
 */
import { hardBlock, hasDangerousPattern } from "./security.js";

export type CommandPolicyMode = "blocklist" | "allow";

const DEFAULT_ALLOW_PREFIXES = [
  "ls",
  "dir",
  "echo",
  "pwd",
  "cd",
  "cat",
  "type",
  "head",
  "tail",
  "git",
  "npm",
  "npx",
  "node",
  "tsc",
  "vitest",
  "biome",
  "whoami",
  "hostname",
  "date",
  "uname",
];

/**
 * allow 模式下禁止的 shell 控制序列（未做完整引号解析，宁可误拦也不放行拼接）
 */
const SHELL_META =
  /(?:[;|`$<>]|\n|\r|&&|\|\||\$\(|`|\b(?:eval|source|exec)\b|\bsh\s+-c\b|\bbash\s+-c\b|\bcmd(?:\.exe)?\s+\/c\b|\bpowershell\b|\bpwsh\b)/i;

export function getCommandPolicyMode(): CommandPolicyMode {
  const raw = (process.env.MCP_COMMAND_POLICY || "blocklist").toLowerCase().trim();
  return raw === "allow" || raw === "whitelist" ? "allow" : "blocklist";
}

/** 解析 MCP_COMMAND_ALLOW：逗号分隔前缀；空则用内置默认 */
export function getAllowPrefixes(): string[] {
  const env = process.env.MCP_COMMAND_ALLOW?.trim();
  if (!env) return [...DEFAULT_ALLOW_PREFIXES];
  return env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeCmd(cmd: string): string {
  return cmd.replace(/^\s+/, "").replace(/^chcp\s+65001\s*>nul\s*&&\s*/i, "");
}

/** 取首个可执行词（去掉路径与 .exe/.cmd/.bat） */
export function firstExecutableToken(cmd: string): string {
  const trimmed = normalizeCmd(cmd).trim();
  const withoutEnv = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
  const m = withoutEnv.match(/^("([^"]+)"|'([^']+)'|(\S+))/);
  if (!m) return "";
  const token = (m[2] || m[3] || m[4] || "").replace(/\\/g, "/");
  const base = token.includes("/") ? token.slice(token.lastIndexOf("/") + 1) : token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function isAllowlisted(cmd: string, prefixes: string[]): boolean {
  const lower = normalizeCmd(cmd).toLowerCase().trim();
  const token = firstExecutableToken(cmd);
  for (const raw of prefixes) {
    const p = raw.toLowerCase().trim();
    if (!p) continue;
    // 词级：首 token 等于 allow 项
    if (token === p) return true;
    // 多词前缀：整串以 "p " 开头或完全等于 p
    if (lower === p || lower.startsWith(`${p} `) || lower.startsWith(`${p}\t`)) return true;
  }
  return false;
}

/** 策略拦截类别 — 供 audit/telemetry 聚合 */
export type PolicyReasonCategory = "empty" | "hardBlock" | "allow-meta" | "allow-list" | "dangerous" | "unknown";

/** 从 checkCommandPolicy 返回的 reason 字符串归类 */
export function classifyPolicyReason(reason: string | null): PolicyReasonCategory | null {
  if (!reason) return null;
  if (reason === "Empty command") return "empty";
  if (reason.startsWith("hard-blocked:")) return "hardBlock";
  if (reason.includes("metacharacters") || reason.includes("nested shells")) return "allow-meta";
  if (reason.startsWith("allow-policy:")) return "allow-list";
  if (reason.startsWith("dangerous-pattern:")) return "dangerous";
  return "unknown";
}

/**
 * 统一命令策略检查。
 * 返回拦截原因字符串，或 null 表示通过。
 */
export function checkCommandPolicy(command: string): string | null {
  const cmd = normalizeCmd(command);
  if (!cmd) return "Empty command";

  const hb = hardBlock(cmd);
  if (hb) return `hard-blocked: ${hb}`;

  const mode = getCommandPolicyMode();
  if (mode === "allow") {
    if (SHELL_META.test(cmd)) {
      return "allow-policy: shell metacharacters or nested shells are not allowed in allow mode";
    }
    const prefixes = getAllowPrefixes();
    if (!isAllowlisted(cmd, prefixes)) {
      const token = firstExecutableToken(cmd) || "?";
      return `allow-policy: executable "${token}" not in allowlist (set MCP_COMMAND_ALLOW or use MCP_COMMAND_POLICY=blocklist)`;
    }
    return null;
  }

  const dp = hasDangerousPattern(cmd);
  if (dp) return `dangerous-pattern: ${dp}`;
  return null;
}
