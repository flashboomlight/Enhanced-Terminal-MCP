/**
 * 统一工具 handler 包装器 — 自动 telemetry + 缓存
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CACHEABLE_TOOLS, LRUCache, TOOL_TTL, toolCache } from "./cache.js";
import { type ToolResult, toCallToolResult } from "./result.js";
import { scanContent } from "./scan.js";
import { telemetry } from "./telemetry.js";

/** 已注册工具总数 —— 每次 wrapHandler 包装一个工具自增，供日志/文档动态统计 */
let _registeredToolCount = 0;
export function getRegisteredToolCount(): number {
  return _registeredToolCount;
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
 * 包装工具 handler：自动记录 telemetry + 缓存命中
 */
export function wrapHandler<T extends Record<string, unknown>>(
  toolName: string,
  fn: (args: T) => Promise<ToolResult>,
): (args: T) => Promise<CallToolResult> {
  _registeredToolCount++;
  const cacheable = CACHEABLE_TOOLS.has(toolName);

  return async (args: T): Promise<CallToolResult> => {
    const t0 = Date.now();
    const cacheKey = cacheable && args ? LRUCache.key(toolName, args as Record<string, unknown>) : "";

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
      toolName,
      latency_ms: elapsed,
      ok: result.ok,
      errorCode: result.ok ? undefined : result.error.code,
      cacheHit: false,
      timestamp: Date.now(),
    });

    const callResult = toCallToolResult(result);

    // 写入缓存：成功且内容无密钥发现才缓存
    if (cacheKey && result.ok) {
      const text = extractCacheableText(callResult);
      if (scanContent(text).safe) {
        toolCache.set(cacheKey, callResult, TOOL_TTL[toolName]);
      }
    }

    return callResult;
  };
}
