// src/safeguard.ts — 集中式安全策略引擎
// 三级模式 (strict/normal/off) + Elicitation 交互确认 + 关键资源硬性保护

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "./logger.js";
import { IS_WIN } from "./platform.js";

// ===== 类型 =====
export type SafetyMode = "strict" | "normal" | "off";

// ===== 受保护的工具名单（strict 模式下全部禁用） =====
const GUARDED_TOOLS = new Set([
  "delete_path",
  "write_file",
  "kill_process",
  "execute_command",
  "batch_execute",
  "watch_command",
]);

// ===== normal 模式下需要 Elicitation 确认的工具（GUARDED_TOOLS 的子集） =====
// execute_command/batch_execute/watch_command 依赖 hasDangerousPattern 检查，不需要 elicitation
const ELICITATION_TOOLS = new Set(["delete_path", "write_file", "kill_process"]);

// ===== 关键进程黑名单（所有模式下禁止杀死） =====
const CRITICAL_PROCESSES_WIN = new Set([
  "csrss.exe",
  "wininit.exe",
  "smss.exe",
  "lsass.exe",
  "services.exe",
  "svchost.exe",
  "dwm.exe",
  "explorer.exe",
  "winlogon.exe",
  "system",
  "system idle process",
]);
const CRITICAL_PROCESSES_UNIX = new Set(["init", "systemd", "launchd", "kernel", "kthreadd"]);

// ===== 内部状态 =====
let _server: McpServer | null = null;
let _mode: SafetyMode = "normal";

/**
 * 读取当前安全模式
 */
export function getSafetyMode(): SafetyMode {
  return _mode;
}

/**
 * 初始化安全锁 — 在 index.ts 中 server 创建后、工具注册前调用一次
 */
export function initSafeGuard(server: McpServer): void {
  _server = server;
  const env = (process.env.MCP_SAFETY_MODE || "normal").toLowerCase().trim();
  if (env === "strict" || env === "normal" || env === "off") {
    _mode = env;
  } else {
    _mode = "normal";
    logger.warn("safeguard", "init", `Unknown MCP_SAFETY_MODE="${env}", falling back to "normal"`);
  }
  logger.info("safeguard", "init", `Safety mode: ${_mode}`);
}

/**
 * 检查是否为关键系统进程 — 所有模式下生效
 */
export function isCriticalProcess(name?: string, pid?: number): boolean {
  // PID 0/1/4 在所有平台上都是关键进程
  if (pid != null && (pid === 0 || pid === 1 || pid === 4)) return true;
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  const list = IS_WIN ? CRITICAL_PROCESSES_WIN : CRITICAL_PROCESSES_UNIX;
  return list.has(lower);
}

/**
 * 安全锁检查 — 破坏性操作的统一入口
 *
 * @param toolName  工具名称
 * @param description  人类可读的操作描述（显示在确认对话框中）
 * @returns null = 放行, string = 拒绝原因
 */
export async function guardDestructiveAction(toolName: string, description: string): Promise<string | null> {
  // off 模式：跳过安全锁（硬性底线在 security.ts 中另外检查）
  if (_mode === "off") {
    return null;
  }

  // strict 模式：受保护工具全部禁用
  if (_mode === "strict") {
    if (GUARDED_TOOLS.has(toolName)) {
      logger.warn("safeguard", "strict-block", `${toolName}: ${description}`);
      return (
        `[SAFETY] Operation blocked: server is running in strict safety mode.\n` +
        `Tool "${toolName}" is marked as destructive and cannot be executed.\n` +
        `Switch to normal mode (MCP_SAFETY_MODE=normal) to enable with confirmation,\n` +
        `or use MCP_SAFETY_MODE=off to disable safety checks entirely.`
      );
    }
    return null;
  }

  // normal 模式：仅对需要确认的工具通过 Elicitation 向用户确认
  if (!ELICITATION_TOOLS.has(toolName)) {
    return null; // 不需要 elicitation 的工具直接放行
  }

  if (!_server) {
    logger.error("safeguard", "no-server", "SafeGuard not initialized — call initSafeGuard(server) first");
    return `[SAFETY] Internal error: SafeGuard not initialized.`;
  }

  try {
    const result = await _server.server.elicitInput({
      message: `⚠️ 安全确认 — ${toolName}\n\n${description}\n\n确认要执行此操作吗？`,
      requestedSchema: {
        type: "object" as const,
        properties: {
          confirm: {
            type: "boolean" as const,
            title: "确认执行",
            description: "选择 true 确认执行，false 取消操作",
          },
        },
        required: ["confirm"],
      },
    });

    if (result.action === "accept" && result.content?.confirm === true) {
      logger.info("safeguard", "confirmed", `${toolName}: user confirmed`);
      return null; // 用户确认，放行
    }

    logger.info("safeguard", "declined", `${toolName}: user declined or cancelled`);
    return `[SAFETY] Operation cancelled by user: ${toolName}`;
  } catch (e: any) {
    // 客户端不支持 Elicitation — 降级拒绝
    logger.warn("safeguard", "elicitation-unavailable", `${toolName}: ${e.message}`);
    return (
      `[SAFETY] This operation requires user confirmation, but the MCP client\n` +
      `does not support interactive confirmation (Elicitation).\n` +
      `\n` +
      `Operation: ${toolName}\n` +
      `Detail: ${description}\n` +
      `\n` +
      `Please either:\n` +
      `  1. Use a client that supports Elicitation (e.g. Claude Desktop)\n` +
      `  2. Set MCP_SAFETY_MODE=off to disable safety checks`
    );
  }
}
