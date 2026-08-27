/**
 * 命令风险分级 —— risk-gated 确认模式的纯分类层（无共享状态、同输入同输出）
 *
 * 规则表是唯一易变面：改动必须过 tests/fixtures/command-risk-corpus.json 语料
 * （DEC-002 / design P3 治理，对齐 roadmap"禁止开放式补正则"纪律）。
 * 破坏类规则只覆盖 command policy 放行后的残余面（P1）；正则一律线性、无嵌套量词。
 */

import { logger } from "./logger.js";

export type CommandRiskLevel = "ordinary" | "heavy";
export type CommandRiskCategory = "batch" | "performance" | "destructive" | "watch";

export interface CommandRisk {
  level: CommandRiskLevel;
  category?: CommandRiskCategory;
  reason?: string;
}

export interface CommandRiskContext {
  tool: string;
  batchSize?: number;
  durationMs?: number;
}

/** risk-gated 分级确认的调用上下文（batch 时携带整批命令供摘要） */
export interface CommandGuardContext {
  batchSize?: number;
  durationMs?: number;
  batchCommands?: string[];
}

export type CommandConfirmationMode = "all" | "risk-gated";

const ORDINARY: CommandRisk = { level: "ordinary" };
export const BATCH_THRESHOLD = 5;
export const WATCH_THRESHOLD_MS = 60_000;
/** 超长命令 fail-safe 判 heavy（design 跨层纪律：宁多确认不崩溃） */
const MAX_CLASSIFY_LENGTH = 16_384;

/** 解析 MCP_COMMAND_CONFIRMATION；非法值回退 all 并告警（对齐 MCP_SAFETY_MODE 解析风格） */
export function parseCommandConfirmationMode(
  raw: string | undefined,
  warn?: (message: string) => void,
): CommandConfirmationMode {
  const value = (raw ?? "all").toLowerCase().trim();
  if (value === "all" || value === "risk-gated") return value;
  warn?.(`Unknown MCP_COMMAND_CONFIRMATION="${value}", falling back to "all"`);
  return "all";
}

/** 读取当前命令确认模式（进程内可随时改环境变量，与 command-policy 同口径不缓存） */
export function getCommandConfirmationMode(): CommandConfirmationMode {
  return parseCommandConfirmationMode(process.env.MCP_COMMAND_CONFIRMATION, (message) =>
    logger.warn("command-risk", "parse", message),
  );
}

/** 破坏类残余规则（P1）：policy 已拦盘符绝对路径等，这里只接放行后的残余 */
const DESTRUCTIVE_RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(?:\S+\s+)*-\w*r/i, reason: "递归删除（rm -r/-rf）" },
  { pattern: /\brm\s+(?:\S+\s+)*--recursive\b/i, reason: "递归删除（rm --recursive）" },
  { pattern: /\bremove-item\s+[^|;&\n]*-(?:rec|recurse)\b/i, reason: "递归删除（Remove-Item -Recurse）" },
  { pattern: /\b(?:rd|rmdir)\s+\/s\b/i, reason: "递归删除（rd/rmdir /s）" },
  { pattern: /\bdel\s+(?:\/[a-z]\s+)*\/s\b/i, reason: "递归删除（del /s）" },
  { pattern: /\bgit\s+clean\b[^|;&\n]*-\w*f/i, reason: "git clean 强制清除未跟踪文件" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard 丢弃工作区改动" },
];

/** 性能类词表：按 token 语义匹配（run-script 检查脚本名，防 echo install 之类误伤，P3） */
const RUN_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "pnpx"]);
const RUN_KEYWORDS = new Set(["run", "exec"]);
const PERFORMANCE_WORDS = new Set(["install", "add", "ci", "publish", "coverage", "test", "vitest"]);

/** 提取参与性能词匹配的 token：首个可执行词 + run-script 场景下的脚本名 */
function riskTokens(command: string): string[] {
  const tokens = command
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, "").toLowerCase());
  const first = tokens[0] ?? "";
  const base =
    first
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat|ps1)$/i, "") ?? "";
  const out = new Set<string>([base]);
  if (RUN_MANAGERS.has(base)) {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.startsWith("-")) break;
      out.add(token);
      if (!RUN_KEYWORDS.has(token)) break;
    }
  }
  return [...out];
}

/** 单命令风险分级：batch/watch 阈值 → 破坏类残余 → 性能词表，命中即 heavy */
export function classifyCommandRisk(command: string, context: CommandRiskContext): CommandRisk {
  if (context.tool === "batch_execute" && (context.batchSize ?? 0) > BATCH_THRESHOLD) {
    return {
      level: "heavy",
      category: "batch",
      reason: `批量执行 ${context.batchSize} 条命令，超过 ${BATCH_THRESHOLD} 条批量上限`,
    };
  }
  if (context.tool === "watch_command" && (context.durationMs ?? 0) > WATCH_THRESHOLD_MS) {
    return {
      level: "heavy",
      category: "watch",
      reason: `监控时长 ${Math.round((context.durationMs ?? 0) / 1000)}s 超过 ${WATCH_THRESHOLD_MS / 1000}s 阈值`,
    };
  }
  if (command.length > MAX_CLASSIFY_LENGTH) {
    return { level: "heavy", category: "destructive", reason: "命令超长，需人工确认后执行" };
  }
  for (const rule of DESTRUCTIVE_RULES) {
    if (rule.pattern.test(command)) {
      return { level: "heavy", category: "destructive", reason: `破坏类操作：${rule.reason}` };
    }
  }
  for (const token of riskTokens(command)) {
    if (PERFORMANCE_WORDS.has(token)) {
      return { level: "heavy", category: "performance", reason: `性能类命令词 “${token}”` };
    }
  }
  return ORDINARY;
}

/** 整批分级：>5 条整批 heavy；否则任一 heavy 条目带原因返回 */
export function classifyBatchRisk(commands: string[]): CommandRisk {
  if (commands.length > BATCH_THRESHOLD) {
    return {
      level: "heavy",
      category: "batch",
      reason: `批量执行 ${commands.length} 条命令，超过 ${BATCH_THRESHOLD} 条批量上限`,
    };
  }
  for (const command of commands) {
    const risk = classifyCommandRisk(command, { tool: "batch_execute" });
    if (risk.level === "heavy") {
      return { level: "heavy", category: risk.category ?? "destructive", reason: risk.reason ?? "" };
    }
  }
  return ORDINARY;
}
