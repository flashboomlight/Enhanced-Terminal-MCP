/**
 * 统一工具 handler 包装器 — 自动 telemetry + 缓存
 */
import { telemetry } from "./telemetry.js";
import { toolCache, CACHEABLE_TOOLS, TOOL_TTL } from "./cache.js";
import { toCallToolResult, type ToolResult } from "./result.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * 包装工具 handler：自动记录 telemetry + 缓存命中
 */
export function wrapHandler<T extends Record<string, unknown>>(
  toolName: string,
  fn: (args: T) => Promise<ToolResult>
): (args: T) => Promise<CallToolResult> {
  const cacheable = CACHEABLE_TOOLS.has(toolName);

  return async (args: T): Promise<CallToolResult> => {
    const t0 = Date.now();
    const cacheKey = cacheable && args ? `${toolName}:${JSON.stringify(args)}` : "";

    // 缓存检查
    if (cacheKey) {
      const cached = toolCache.get(cacheKey);
      if (cached) {
        telemetry.record({ toolName, latency_ms: Date.now() - t0, ok: true, cacheHit: true, timestamp: Date.now() });
        return cached.value;
      }
    }

    // 执行
    const result = await fn(args);
    const elapsed = Date.now() - t0;

    // 记录 telemetry
    telemetry.record({
      toolName, latency_ms: elapsed, ok: result.ok,
      errorCode: result.ok ? undefined : result.error.code,
      cacheHit: false, timestamp: Date.now(),
    });

    const callResult = toCallToolResult(result);

    // 写入缓存
    if (cacheKey && result.ok) {
      toolCache.set(cacheKey, callResult, TOOL_TTL[toolName]);
    }

    return callResult;
  };
}
