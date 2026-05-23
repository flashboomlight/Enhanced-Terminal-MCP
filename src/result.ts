/**
 * 统一工具结果协议 + 错误码系统
 *
 * 每个工具返回 ToolSuccess<T> | ToolError
 * - content: 人类可读文本（LLM 也可读）
 * - structured: 类型安全的机器可解析 JSON
 * - error: 结构化错误体（LLM 可据此决定重试/修正/放弃）
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ====================================================================
// 错误码枚举
// ====================================================================
export const ErrorCode = {
  PATH_TRAVERSAL: "PATH_TRAVERSAL",
  PATH_FORBIDDEN: "PATH_FORBIDDEN",
  PATH_NOT_FOUND: "PATH_NOT_FOUND",
  PATH_SENSITIVE: "PATH_SENSITIVE",
  PATH_EMPTY: "PATH_EMPTY",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  COMMAND_DANGEROUS: "COMMAND_DANGEROUS",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  TIMEOUT: "TIMEOUT",
  PROCESS_PROTECTED: "PROCESS_PROTECTED",
  SAFETY_BLOCKED: "SAFETY_BLOCKED",
  ELICITATION_REQUIRED: "ELICITATION_REQUIRED",
  ELICITATION_CANCELLED: "ELICITATION_CANCELLED",
  EXECUTION_FAILED: "EXECUTION_FAILED",
  NOT_FOUND: "NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  URL_INVALID: "URL_INVALID",
  HOST_INVALID: "HOST_INVALID",
  ARCHIVE_FAILED: "ARCHIVE_FAILED",
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// ====================================================================
// 结果类型
// ====================================================================
export interface ToolSuccess<T = unknown> {
  ok: true;
  content: string;
  structured: T;
  meta?: ToolMeta;
}

export interface ToolError {
  ok: false;
  content: string;
  error: StructuredError;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolError;

export interface StructuredError {
  code: ErrorCodeType;
  message: string;
  retryable: boolean;
  suggestion?: string;
  param?: string;
  detail?: unknown;
}

export interface ToolMeta {
  truncated?: boolean;
  cursor?: string;
  latency_ms: number;
  cache_hit?: boolean;
  page?: number;
  total_pages?: number;
}

// ====================================================================
// 辅助工厂函数
// ====================================================================
export function success<T>(content: string, structured: T, meta?: Partial<ToolMeta>): ToolSuccess<T> {
  const finalMeta: ToolMeta = {
    ...meta,
    latency_ms: meta?.latency_ms ?? 0,
  };
  return { ok: true, content, structured, meta: finalMeta };
}

export function fail(
  code: ErrorCodeType,
  message: string,
  opts?: { retryable?: boolean; suggestion?: string; param?: string; detail?: unknown }
): ToolError {
  return {
    ok: false,
    content: `[${code}] ${message}`,
    error: {
      code,
      message,
      retryable: opts?.retryable ?? false,
      suggestion: opts?.suggestion,
      param: opts?.param,
      detail: opts?.detail,
    },
  };
}

// 常用错误快捷工厂
export const Errors = {
  pathTraversal: (_path: string) =>
    fail(ErrorCode.PATH_TRAVERSAL, "Path traversal detected", {
      retryable: false,
      param: "path",
      suggestion: "Use a path within allowed directories",
    }),

  pathForbidden: (_path: string) =>
    fail(ErrorCode.PATH_FORBIDDEN, "Path is in a protected system directory", {
      retryable: false,
      param: "path",
    }),

  pathSensitive: (_path: string) =>
    fail(ErrorCode.PATH_SENSITIVE, "Path points to a sensitive/credential file", {
      retryable: false,
      param: "path",
    }),

  pathNotFound: (_path: string) =>
    fail(ErrorCode.PATH_NOT_FOUND, "File or directory not found", {
      retryable: true,
      param: "path",
      suggestion: "Check the path spelling and try again",
    }),

  pathEmpty: () =>
    fail(ErrorCode.PATH_EMPTY, "Path cannot be empty", {
      retryable: true,
      param: "path",
      suggestion: "Provide a valid absolute or relative path",
    }),

  commandDangerous: (cmd: string, pattern: string) =>
    fail(ErrorCode.COMMAND_DANGEROUS, `Dangerous pattern detected: ${pattern}`, {
      retryable: false,
      param: "command",
      suggestion: "Remove the dangerous pattern and try a safer alternative",
      detail: { command: cmd, pattern },
    }),

  validationError: (message: string, param?: string, suggestion?: string) =>
    fail(ErrorCode.VALIDATION_ERROR, message, {
      retryable: true,
      param,
      suggestion,
    }),

  timeout: (cmd: string, ms: number) =>
    fail(ErrorCode.TIMEOUT, `Command timed out after ${ms}ms`, {
      retryable: true,
      suggestion: `Try increasing the timeout or simplifying the command`,
      detail: { command: cmd, timeout_ms: ms },
    }),

  processProtected: (name: string) =>
    fail(ErrorCode.PROCESS_PROTECTED, "Cannot kill a protected system process", {
      retryable: false,
      param: "name",
      detail: { process: name },
    }),

  safetyBlocked: (tool: string, reason: string) =>
    fail(ErrorCode.SAFETY_BLOCKED, `Blocked by safety policy: ${reason}`, {
      retryable: false,
      param: "tool",
      detail: { tool, reason },
    }),

  executionFailed: (message: string, detail?: unknown) =>
    fail(ErrorCode.EXECUTION_FAILED, message, {
      retryable: true,
      detail,
    }),

  internalError: (message: string, detail?: unknown) =>
    fail(ErrorCode.INTERNAL_ERROR, message, {
      retryable: false,
      detail,
    }),

  urlInvalid: (url: string, reason: string) =>
    fail(ErrorCode.URL_INVALID, reason, {
      retryable: true,
      param: "url",
      detail: { url },
    }),

  hostInvalid: (host: string, reason: string) =>
    fail(ErrorCode.HOST_INVALID, reason, {
      retryable: true,
      param: "target",
      detail: { host },
    }),
};

// ====================================================================
// MCP CallToolResult 兼容转换
// ====================================================================

export function toCallToolResult(result: ToolResult): CallToolResult {
  if (result.ok) {
    const content = [
      {
        type: "text" as const,
        text: result.content,
      },
    ];
    if (result.structured !== undefined && result.structured !== null && typeof result.structured === "object" && !Array.isArray(result.structured)) {
      return { content, structuredContent: result.structured as Record<string, unknown> };
    }
    return { content };
  }
  return {
    content: [{ type: "text" as const, text: result.content }],
    isError: true,
  } as CallToolResult;
}
