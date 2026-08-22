// src/safeguard.ts — 集中式安全策略引擎
// 三级模式 (strict/normal/off) + Elicitation 交互确认 + 关键资源硬性保护

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "./audit.js";
import { logger } from "./logger.js";
import { IS_WIN } from "./platform.js";

// ===== 类型 =====
export type SafetyMode = "strict" | "normal" | "off";
export type ConfirmationMode = "elicitation" | "headless" | "auto";

export type SafetyDecision =
  | { status: "allow"; source: "policy" | "elicitation" | "headless" }
  | { status: "required"; reason: "elicitation"; clientSupportsElicitation: boolean }
  | { status: "declined"; source: "elicitation" }
  | { status: "blocked"; reason: "strict" | "path" | "policy" | "hard_block" | "headless_surface" };

// ===== 受保护的工具名单（strict 模式下全部禁用） =====
const GUARDED_TOOLS = new Set([
  "delete_path",
  "write_file",
  "copy_move",
  "compress_archive",
  "extract_archive",
  "download_file",
  "kill_process",
  "execute_command",
  "batch_execute",
  "watch_command",
]);

// ===== normal 模式下需要 Elicitation 确认的工具（GUARDED_TOOLS 的子集） =====
const ELICITATION_TOOLS = new Set(GUARDED_TOOLS);

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
let _confirmationMode: ConfirmationMode = "elicitation";

const SAFETY_PROTOCOL_VERSION = 2 as const;

/**
 * 读取当前安全模式
 */
export function getSafetyMode(): SafetyMode {
  return _mode;
}

/**
 * 读取确认通道模式；未设置时保持旧的 Elicitation 行为。
 */
export function getConfirmationMode(): ConfirmationMode {
  return _confirmationMode;
}

/**
 * 返回当前安全协议版本。
 */
export function getSafetyProtocolVersion(): typeof SAFETY_PROTOCOL_VERSION {
  return SAFETY_PROTOCOL_VERSION;
}

/**
 * 当前 headless surface 只允许 workspace-delete。
 */
export function isHeadlessWorkspaceDeleteTool(toolName: string): boolean {
  return _confirmationMode === "headless" && toolName === "delete_path";
}

/**
 * headless 下排除未纳入本 feature 的副作用工具。
 */
export function isHeadlessExcludedTool(toolName: string): boolean {
  return _confirmationMode === "headless" && toolName !== "delete_path";
}

/**
 * 判断客户端是否声明支持 form Elicitation。
 */
export function supportsFormElicitation(): boolean {
  const getCapabilities = _server?.server.getClientCapabilities;
  if (typeof getCapabilities !== "function") return true;
  return getCapabilities.call(_server?.server)?.elicitation?.form !== undefined;
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
  const confirmationEnv = (process.env.MCP_CONFIRMATION_MODE || "elicitation").toLowerCase().trim();
  if (confirmationEnv === "elicitation" || confirmationEnv === "headless" || confirmationEnv === "auto") {
    _confirmationMode = confirmationEnv;
  } else {
    _confirmationMode = "elicitation";
    logger.warn(
      "safeguard",
      "init",
      `Unknown MCP_CONFIRMATION_MODE="${confirmationEnv}", falling back to "elicitation"`,
    );
  }
  logger.info("safeguard", "init", `Safety mode: ${_mode}; confirmation mode: ${_confirmationMode}`);
  if (_confirmationMode === "headless" && _mode === "off") {
    logger.warn(
      "safeguard",
      "init",
      "MCP_SAFETY_MODE=off has no effect on guarded tools in headless confirmation mode; the workspace-delete surface is enforced",
    );
  }
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
export async function evaluateDestructiveAction(toolName: string, description: string): Promise<SafetyDecision> {
  const decision = await decideDestructiveAction(toolName, description);
  if (decision.status !== "allow") auditSafetyDecision(toolName, decision);
  return decision;
}

/** 非 allow 决策统一写入审计（不含 secret 与操作参数原文） */
function auditSafetyDecision(toolName: string, decision: Exclude<SafetyDecision, { status: "allow" }>): void {
  const errorCode =
    decision.status === "required"
      ? "ELICITATION_REQUIRED"
      : decision.status === "declined"
        ? "ELICITATION_CANCELLED"
        : "SAFETY_BLOCKED";
  const detail: Record<string, unknown> = {
    decision: decision.status,
    confirmation_mode: _confirmationMode,
    error_code: errorCode,
  };
  if (decision.status === "blocked") detail.reason = decision.reason;
  if (decision.status === "declined") detail.source = decision.source;
  if (decision.status === "required") detail.client_supports_elicitation = decision.clientSupportsElicitation;
  audit.record({ action: "safety.decision", tool: toolName, detail, success: false });
}

async function decideDestructiveAction(toolName: string, description: string): Promise<SafetyDecision> {
  // strict 模式：受保护工具全部禁用（strict 优先于确认通道）
  if (_mode === "strict") {
    if (GUARDED_TOOLS.has(toolName)) {
      logger.warn("safeguard", "strict-block", `${toolName}: ${description}`);
      return { status: "blocked", reason: "strict" };
    }
    return { status: "allow", source: "policy" };
  }

  // headless surface：由确认通道建立的授权边界，优先于 off —— off 不消解 surface
  if (_confirmationMode === "headless") {
    if (toolName === "delete_path") return { status: "allow", source: "headless" };
    return { status: "blocked", reason: "headless_surface" };
  }

  // off 模式：跳过安全锁（硬性底线在 security.ts 中另外检查）
  if (_mode === "off") {
    return { status: "allow", source: "policy" };
  }

  // normal 模式：仅对需要确认的工具通过 Elicitation 向用户确认
  if (!ELICITATION_TOOLS.has(toolName)) {
    return { status: "allow", source: "policy" }; // 不需要 elicitation 的工具直接放行
  }

  const clientSupportsElicitation = supportsFormElicitation();
  if (_confirmationMode === "auto" && !clientSupportsElicitation) {
    return { status: "required", reason: "elicitation", clientSupportsElicitation: false };
  }
  if (!_server || !clientSupportsElicitation) {
    return { status: "required", reason: "elicitation", clientSupportsElicitation };
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
      return { status: "allow", source: "elicitation" }; // 用户确认，放行
    }

    logger.info("safeguard", "declined", `${toolName}: user declined or cancelled`);
    return { status: "declined", source: "elicitation" };
  } catch (e: unknown) {
    // 客户端不支持 Elicitation — 降级拒绝
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("safeguard", "elicitation-unavailable", `${toolName}: ${msg}`);
    return { status: "required", reason: "elicitation", clientSupportsElicitation: false };
  }
}

/**
 * 兼容现有工具 handler 的字符串安全锁入口。
 */
export async function guardDestructiveAction(toolName: string, description: string): Promise<string | null> {
  if (!_server && _mode === "normal" && ELICITATION_TOOLS.has(toolName)) {
    logger.error("safeguard", "no-server", "SafeGuard not initialized — call initSafeGuard(server) first");
    return `[SAFETY] Internal error: SafeGuard not initialized.`;
  }
  const decision = await evaluateDestructiveAction(toolName, description);
  if (decision.status === "allow") return null;
  return describeSafetyDecision(decision, toolName, description);
}

/**
 * 将安全决策转换为人类可读的兼容消息；工具层可按 decision 映射结构化错误码。
 */
export function describeSafetyDecision(decision: SafetyDecision, toolName: string, description: string): string {
  if (decision.status === "allow") return "";
  switch (decision.status) {
    case "required":
      return (
        `[SAFETY] This operation requires user confirmation, but the MCP client\n` +
        `does not support interactive confirmation (Elicitation).\n` +
        `Operation: ${toolName}\n` +
        `Detail: ${description}`
      );
    case "declined":
      return `[SAFETY] Operation cancelled by user: ${toolName}`;
    case "blocked":
      if (decision.reason === "strict") {
        return (
          `[SAFETY] Operation blocked: server is running in strict safety mode.\n` +
          `Tool "${toolName}" is marked as destructive and cannot be executed.`
        );
      }
      if (decision.reason === "headless_surface") {
        return `[SAFETY] Operation blocked: tool "${toolName}" is outside the headless workspace-delete surface.`;
      }
      return `[SAFETY] Operation blocked by ${decision.reason}: ${toolName}`;
  }
}
