/**
 * 统一工具结果协议 + 错误码系统
 *
 * 每个工具返回 ToolSuccess<T> | ToolError
 * - content: 人类可读文本（LLM 也可读）
 * - structured: 类型安全的机器可解析 JSON
 * - error: 结构化错误体（LLM 可据此决定重试/修正/放弃）
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

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
  SECRET_DETECTED: "SECRET_DETECTED",
  RESOURCE_LIMIT: "RESOURCE_LIMIT",
  CANCELLED: "CANCELLED",
  PROCESS_TREE_TERMINATION_FAILED: "PROCESS_TREE_TERMINATION_FAILED",
  SANDBOX_UNAVAILABLE: "SANDBOX_UNAVAILABLE",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  ARCHIVE_LIMIT: "ARCHIVE_LIMIT",
  STATE_PERSISTENCE_FAILED: "STATE_PERSISTENCE_FAILED",
  CAPABILITY_DENIED: "CAPABILITY_DENIED",
  PROCESS_IDENTITY_AMBIGUOUS: "PROCESS_IDENTITY_AMBIGUOUS",
  PARTIAL_RESULT: "PARTIAL_RESULT",
  CONFIG_INVALID: "CONFIG_INVALID",
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
  meta?: ToolMeta;
  /** 错误时保留命令类的机器可读 envelope，不改变 isError 语义。 */
  structured?: Record<string, unknown>;
}

export type ToolResult<T = unknown> = ToolSuccess<T> | ToolError;

export type CacheDisabledReason = "secret_detected" | "temp_capacity_exceeded" | "temp_unavailable";

export interface CommandOutputEnvelope {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  cancelled: boolean;
  truncated: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  paged: boolean;
  total_output_bytes: number;
  retained_output_bytes: number;
  stdout_total_bytes: number;
  stdout_retained_bytes: number;
  stderr_total_bytes: number;
  stderr_retained_bytes: number;
  total_chars: number;
  stdout_encoding: "utf8" | "gbk";
  stderr_encoding: "utf8" | "gbk";
  cache_id?: string;
  page?: number;
  total_pages?: number;
  page_size?: number;
  cache_disabled_reason?: CacheDisabledReason;
  capture_limit_reached?: boolean;
  captured_ms?: number;
  error?: StructuredError;
}

export type BatchCommandResult =
  | ({ index: number; command: string; status: "completed" } & CommandOutputEnvelope & { latency_ms: number })
  | { index: number; command: string; status: "skipped"; skip_reason: "stop_on_error" };

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
  safety_protocol_version?: 2;
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
  opts?: {
    retryable?: boolean;
    suggestion?: string;
    param?: string;
    detail?: unknown;
    structured?: Record<string, unknown>;
    meta?: Partial<ToolMeta>;
  },
): ToolError {
  const meta = opts?.meta
    ? {
        ...opts.meta,
        latency_ms: opts.meta.latency_ms ?? 0,
      }
    : undefined;
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
    ...(meta ? { meta } : {}),
    structured: opts?.structured,
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

  /** 策略层统一拦截（hardBlock / allowlist / dangerous pattern） */
  commandBlocked: (cmd: string, reason: string, param = "command") =>
    fail(ErrorCode.COMMAND_DANGEROUS, `Command blocked — ${reason}`, {
      retryable: false,
      param,
      detail: { command: cmd, reason },
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

  resourceLimit: (message: string, detail?: unknown) =>
    fail(ErrorCode.RESOURCE_LIMIT, message, { retryable: true, detail }),

  cancelled: (message = "Operation cancelled", detail?: unknown) =>
    fail(ErrorCode.CANCELLED, message, { retryable: true, detail }),

  processTreeTerminationFailed: (message = "Process tree termination failed", detail?: unknown) =>
    fail(ErrorCode.PROCESS_TREE_TERMINATION_FAILED, message, { retryable: true, detail }),

  sandboxUnavailable: (message = "Sandbox execution is unavailable", detail?: unknown) =>
    fail(ErrorCode.SANDBOX_UNAVAILABLE, message, { retryable: false, detail }),

  ssrfBlocked: (message = "Network target blocked by SSRF policy", detail?: unknown) =>
    fail(ErrorCode.SSRF_BLOCKED, message, { retryable: false, param: "url", detail }),

  archiveLimit: (message = "Archive resource limit exceeded", detail?: unknown) =>
    fail(ErrorCode.ARCHIVE_LIMIT, message, { retryable: false, detail }),

  statePersistenceFailed: (message = "State persistence failed", detail?: unknown) =>
    fail(ErrorCode.STATE_PERSISTENCE_FAILED, message, { retryable: true, detail }),

  capabilityDenied: (message = "Capability denied by execution profile", detail?: unknown) =>
    fail(ErrorCode.CAPABILITY_DENIED, message, { retryable: false, detail }),

  processIdentityAmbiguous: (message = "Process identity is ambiguous", detail?: unknown) =>
    fail(ErrorCode.PROCESS_IDENTITY_AMBIGUOUS, message, { retryable: false, detail }),

  partialResult: (message = "Result is incomplete", detail?: unknown) =>
    fail(ErrorCode.PARTIAL_RESULT, message, { retryable: true, detail }),

  configInvalid: (message: string, param?: string, detail?: unknown) =>
    fail(ErrorCode.CONFIG_INVALID, message, { retryable: false, param, detail }),
};

// ====================================================================
// MCP CallToolResult 兼容转换
// ====================================================================

/** 结构化错误体 zod schema（供 outputSchema 错误分支复用） */
export const structuredErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  suggestion: z.string().optional(),
  param: z.string().optional(),
  detail: z.unknown().optional(),
});

/** 命令类工具共用的机器可读输出 envelope schema。 */
export const commandOutputSchema = z.object({
  ok: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().nullable(),
  timed_out: z.boolean(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  stdout_truncated: z.boolean(),
  stderr_truncated: z.boolean(),
  paged: z.boolean(),
  total_output_bytes: z.number(),
  retained_output_bytes: z.number(),
  stdout_total_bytes: z.number(),
  stdout_retained_bytes: z.number(),
  stderr_total_bytes: z.number(),
  stderr_retained_bytes: z.number(),
  total_chars: z.number(),
  stdout_encoding: z.enum(["utf8", "gbk"]),
  stderr_encoding: z.enum(["utf8", "gbk"]),
  cache_id: z.string().optional(),
  page: z.number().optional(),
  total_pages: z.number().optional(),
  page_size: z.number().optional(),
  cache_disabled_reason: z.enum(["secret_detected", "temp_capacity_exceeded", "temp_unavailable"]).optional(),
  capture_limit_reached: z.boolean().optional(),
  captured_ms: z.number().optional(),
  error: structuredErrorSchema.optional(),
});

/** batch completed/skipped union 的公共输出 schema。 */
export const completedBatchSchema = z.object({
  index: z.number(),
  command: z.string(),
  status: z.literal("completed"),
  latency_ms: z.number(),
  ...commandOutputSchema.shape,
});

export const skippedBatchSchema = z.object({
  index: z.number(),
  command: z.string(),
  status: z.literal("skipped"),
  skip_reason: z.literal("stop_on_error"),
});

/**
 * 工具 outputSchema 合并错误 envelope 字段。
 *
 * SDK 1.29 的 outputSchema 必须能 normalize 成单一 object schema（union 会被丢弃并
 * 导致调用期校验崩溃），且客户端对 isError 结果附带的 structuredContent 也做严格
 * 校验；因此把成功字段降为 optional 并并入 ok/error 字段，让成功与错误两种形态
 * 都通过同一份 object schema——错误路径不再丢失机器可读 structuredContent。
 * M2（4.6 envelope）会进一步把命令类工具收敛为完整单对象 envelope。
 */
export function withErrorSchema<T extends z.ZodRawShape>(successSchema: z.ZodObject<T>) {
  return successSchema.partial().extend({
    ok: z.boolean().optional(),
    error: structuredErrorSchema.optional(),
  });
}

export function toCallToolResult(result: ToolResult): CallToolResult {
  const protocolMeta = result.meta?.safety_protocol_version === 2 ? { _meta: { ...result.meta } } : {};
  if (result.ok) {
    const content = [
      {
        type: "text" as const,
        text: result.content,
      },
    ];
    if (
      result.structured !== undefined &&
      result.structured !== null &&
      typeof result.structured === "object" &&
      !Array.isArray(result.structured)
    ) {
      return { ...protocolMeta, content, structuredContent: result.structured as Record<string, unknown> };
    }
    return { ...protocolMeta, content };
  }
  return {
    ...protocolMeta,
    content: [{ type: "text" as const, text: result.content }],
    isError: true,
    structuredContent: { ...(result.structured ?? {}), ok: false as const, error: result.error },
  } as CallToolResult;
}
