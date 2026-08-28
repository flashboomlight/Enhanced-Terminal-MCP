/**
 * 自适应超时计算 — 基于工具历史延迟 P95 动态调整
 */
import { telemetry } from "./telemetry.js";

// 仅收录实际走 adaptiveTimeout 的调用点；其它工具的超时由各自 handler 显式给定
const DEFAULT_TIMEOUTS: Record<string, number> = {
  execute_command: 30000,
};

/**
 * 计算工具自适应超时
 * formula: max(默认值, min(round(nearest-rank P95 × 3), 默认值 × 4))
 * P95 取非 cache-hit 样本排序后第 ceil(0.95 × n) 名（1-based）；样本 < 5 回退默认值
 */
export function adaptiveTimeout(toolName: string, defaultMs?: number): number {
  const base = defaultMs ?? DEFAULT_TIMEOUTS[toolName] ?? 30000;
  const samples = telemetry.latencySamples(toolName);

  if (samples.length < 5) return base;

  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  const adaptive = Math.round(p95 * 3);
  return Math.max(base, Math.min(adaptive, base * 4)); // 上限 4× 默认
}

/**
 * 指数退避重试：网络/IO 类工具失败后自动重试
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelay?: number; toolName?: string },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelay ?? 500;

  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries) throw e;
      const delay = baseDelay * 2 ** i + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

export { DEFAULT_TIMEOUTS };
