/**
 * 统一工具 handler 包装器 — 异常/取消边界 + 响应字节兜底 + telemetry + 缓存
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CACHEABLE_TOOLS, LRUCache, TOOL_TTL, toolCache } from "./cache.js";
import type { RequestContext, RequestHandlerExtraLike } from "./hardening-contract.js";
import { parseStrictInteger } from "./hardening-contract.js";
import { logger } from "./logger.js";
import { createRequestContext, getActiveExecutionProfile } from "./profile.js";
import { Errors, type ToolResult, toCallToolResult } from "./result.js";
import { scanContent, shouldScanOnCache } from "./scan.js";
import { redactError } from "./secret-governance.js";
import { telemetry } from "./telemetry.js";

/** MCP_RESPONSE_MAX_BYTES 默认值：工具响应（content + structuredContent）字节兜底上限 */
const DEFAULT_RESPONSE_MAX_BYTES = 2_097_152;

/** 进程内仅解析一次的响应字节上限；非法配置回落默认并告警 */
let cachedResponseMaxBytes: number | null = null;
function getResponseMaxBytes(): number {
  if (cachedResponseMaxBytes !== null) return cachedResponseMaxBytes;
  try {
    cachedResponseMaxBytes = parseStrictInteger(process.env.MCP_RESPONSE_MAX_BYTES, {
      name: "MCP_RESPONSE_MAX_BYTES",
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      defaultValue: DEFAULT_RESPONSE_MAX_BYTES,
    });
  } catch (err) {
    logger.warn("wrap", "bad-response-max-bytes", String(err));
    cachedResponseMaxBytes = DEFAULT_RESPONSE_MAX_BYTES;
  }
  return cachedResponseMaxBytes;
}

/** 度量响应字节（content + structuredContent 的 UTF-8 序列化口径）；不可序列化视为超限 */
function measureResponseBytes(result: ToolResult): number {
  let bytes = Buffer.byteLength(result.content, "utf8");
  if (result.structured !== undefined) {
    bytes += Buffer.byteLength(JSON.stringify(result.structured), "utf8");
  }
  return bytes;
}

/** 从 CallToolResult 抽取可扫描文本（防内容含密钥仍入缓存） */
function extractCacheableText(callResult: CallToolResult): string {
  const parts: string[] = [];
  for (const c of callResult.content ?? []) {
    if (c && typeof c === "object" && "type" in c && (c as { type: string }).type === "text") {
      const t = (c as { text?: string }).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.join("\n");
}

/**
 * 包装工具 handler：异常/取消边界 + 响应兜底 + telemetry + 缓存命中
 */
export function wrapHandler<T extends Record<string, unknown>>(
  toolName: string,
  fn: (args: T, context: RequestContext) => Promise<ToolResult>,
): (args: T, extra?: RequestHandlerExtraLike) => Promise<CallToolResult> {
  const cacheable = CACHEABLE_TOOLS.has(toolName);
  const directCallExtra: RequestHandlerExtraLike = {
    requestId: "direct-call",
    signal: new AbortController().signal,
  };

  return async (args: T, extra?: RequestHandlerExtraLike): Promise<CallToolResult> => {
    const t0 = Date.now();
    const context = createRequestContext(extra ?? directCallExtra, getActiveExecutionProfile());
    const cacheKey = cacheable && args ? LRUCache.key(toolName, args as Record<string, unknown>) : "";

    // 缓存检查
    if (cacheKey) {
      const cached = toolCache.get(cacheKey);
      if (cached) {
        telemetry.record({ toolName, latency_ms: Date.now() - t0, ok: true, cacheHit: true, timestamp: Date.now() });
        return cached.value;
      }
    }

    // 执行（未预期异常统一收敛为结构化 ToolResult，不向 transport 泄露 rejected promise）
    let result: ToolResult;
    try {
      result = await fn(args, context);
    } catch (e: unknown) {
      const cancelled = context.signal.aborted || (e instanceof Error && e.name === "AbortError");
      logger.warn("wrap", cancelled ? "handler-aborted" : "unhandled-handler-error", toolName);
      telemetry.record({
        toolName,
        latency_ms: Date.now() - t0,
        ok: false,
        errorCode: cancelled ? "CANCELLED" : "INTERNAL_ERROR",
        cacheHit: false,
        timestamp: Date.now(),
      });
      return toCallToolResult(
        cancelled ? Errors.cancelled(`Tool call cancelled: ${toolName}`) : Errors.internalError(redactError(e).message),
      );
    }

    // 响应字节兜底：超限替换为 RESOURCE_LIMIT（detail 仅有限元），错误 envelope 走既有转换
    try {
      const bytes = measureResponseBytes(result);
      const limit = getResponseMaxBytes();
      if (bytes > limit) {
        result = Errors.resourceLimit("Tool response exceeds the response byte budget", {
          tool: toolName,
          bytes,
          limit,
        });
      }
    } catch (err) {
      logger.warn("wrap", "response-serialize-failed", toolName);
      result = Errors.internalError("Tool response is not serializable");
      void err;
    }

    const elapsed = Date.now() - t0;

    // 记录 telemetry
    telemetry.record({
      toolName,
      latency_ms: elapsed,
      ok: result.ok,
      errorCode: result.ok ? undefined : result.error.code,
      cacheHit: false,
      timestamp: Date.now(),
    });

    const callResult = toCallToolResult(result);

    // 写入缓存：成功且（不扫描缓存 或 内容扫描安全且完整）才缓存——扫描不完整的内容一律不进共享缓存
    if (cacheKey && result.ok) {
      const text = extractCacheableText(callResult);
      if (!shouldScanOnCache()) {
        toolCache.set(cacheKey, callResult, TOOL_TTL[toolName]);
      } else {
        const scan = scanContent(text);
        if (scan.safe && scan.complete) {
          toolCache.set(cacheKey, callResult, TOOL_TTL[toolName]);
        }
      }
    }

    return callResult;
  };
}
