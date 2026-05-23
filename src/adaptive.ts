/**
 * 自适应超时计算 — 基于工具历史延迟 P95 动态调整
 */
import { telemetry } from "./telemetry.js";

const DEFAULT_TIMEOUTS: Record<string, number> = {
  execute_command: 30000,
  batch_execute: 60000,
  watch_command: 5000,
  get_system_info: 30000,
  process_list: 12000,
  search_files: 5000,
  grep_content: 5000,
  compress_archive: 60000,
  extract_archive: 60000,
  download_file: 120000,
};

/**
 * 计算工具自适应超时
 * formula: max(默认值, P95历史延迟 × 2)
 */
export function adaptiveTimeout(toolName: string, defaultMs?: number): number {
  const base = defaultMs ?? DEFAULT_TIMEOUTS[toolName] ?? 30000;
  const agg = telemetry.aggregate();
  const stats = agg.get(toolName);

  if (!stats || stats.count < 5) return base;

  // P95 粗略估算：avg × 3（经验系数，偏斜分布下可能不准，但足够作为超时保护）
  const adaptive = Math.round(stats.avgLatency * 3);
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
