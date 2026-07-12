/**
 * 命令策略：默认黑名单 + hardBlock；可选 allow 白名单（MCP_COMMAND_POLICY=allow）
 *
 * allow 模式仅允许：
 * 1) 前缀匹配 MCP_COMMAND_ALLOW 列表（逗号分隔，如 "npm ,git ,node "）
 * 2) 或匹配内置安全前缀（ls/dir/echo/pwd/cat/type 等只读类）
 * 仍会先跑 hardBlock。
 */
import { hardBlock, hasDangerousPattern } from "./security.js";

export type CommandPolicyMode = "blocklist" | "allow";

const DEFAULT_ALLOW_PREFIXES = [
  "ls ",
  "ls\t",
  "dir ",
  "dir\t",
  "echo ",
  "pwd",
  "cd ",
  "cat ",
  "type ",
  "head ",
  "tail ",
  "git ",
  "npm ",
  "npx ",
  "node ",
  "tsc ",
  "vitest ",
  "biome ",
  "whoami",
  "hostname",
  "date",
  "uname",
];

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

/**
 * 统一命令策略检查。
 * 返回拦截原因字符串，或 null 表示通过。
 */
export function checkCommandPolicy(command: string): string | null {
  const cmd = normalizeCmd(command);
  if (!cmd) return "Empty command";

  // hardBlock 始终优先
  const hb = hardBlock(cmd);
  if (hb) return `hard-blocked: ${hb}`;

  const mode = getCommandPolicyMode();
  if (mode === "allow") {
    const prefixes = getAllowPrefixes();
    const lower = cmd.toLowerCase();
    const ok = prefixes.some((p) => {
      const pl = p.toLowerCase().trimEnd();
      if (lower === pl) return true;
      // 前缀后须空白，避免 python 匹配 pythonism
      if (lower.startsWith(`${pl} `) || lower.startsWith(`${pl}\t`)) return true;
      return false;
    });
    if (!ok) {
      return `allow-policy: command not in allowlist (set MCP_COMMAND_ALLOW or use MCP_COMMAND_POLICY=blocklist)`;
    }
    return null;
  }

  // blocklist 模式：危险模式
  const dp = hasDangerousPattern(cmd);
  if (dp) return `dangerous-pattern: ${dp}`;
  return null;
}
