// src/logger.ts — 结构化日志系统

import { sanitizeLogField } from "./secret-governance.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getCurrentLevel(): LogLevel {
  const env = (process.env.MCP_LOG_LEVEL as LogLevel) || "info";
  return LOG_LEVEL_PRIORITY[env] !== undefined ? env : "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getCurrentLevel()];
}

function formatMsg(level: LogLevel, tool: string, action: string, detail?: string): string {
  const ts = new Date().toISOString();
  // 字段统一经 sanitizeLogField：控制字符转义防 log forging + redact + 限长
  const base = `[${ts}] [${level.toUpperCase()}] [${sanitizeLogField(tool, 64)}] ${sanitizeLogField(action, 128)}`;
  return detail !== undefined ? `${base}: ${sanitizeLogField(detail)}` : base;
}

export const logger = {
  debug(tool: string, action: string, detail?: string) {
    if (shouldLog("debug")) console.error(formatMsg("debug", tool, action, detail));
  },
  info(tool: string, action: string, detail?: string) {
    if (shouldLog("info")) console.error(formatMsg("info", tool, action, detail));
  },
  warn(tool: string, action: string, detail?: string) {
    if (shouldLog("warn")) console.error(formatMsg("warn", tool, action, detail));
  },
  error(tool: string, action: string, detail?: string) {
    if (shouldLog("error")) console.error(formatMsg("error", tool, action, detail));
  },
};
