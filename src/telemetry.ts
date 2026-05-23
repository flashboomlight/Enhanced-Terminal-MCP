/**
 * Telemetry — 工具调用指标收集
 * 非侵入式：工具 handler 无需修改，通过包装器自动收集
 */
import { logger } from "./logger.js";

export interface ToolCallMetric {
  toolName: string;
  latency_ms: number;
  ok: boolean;
  errorCode?: string;
  cacheHit: boolean;
  timestamp: number;
}

class TelemetryStore {
  private metrics: ToolCallMetric[] = [];
  private readonly maxHistory = 1000;
  private startTime = Date.now();
  // 增量聚合缓存
  private _agg = new Map<string, { totalLatency: number; count: number; errors: number; cacheHits: number }>();
  private _aggDirty = false;
  // 全局增量计数器
  private _totalLatency = 0;
  private _totalErrors = 0;
  private _totalCacheHits = 0;
  private _globalDirty = false;

  record(metric: ToolCallMetric): void {
    this.metrics.push(metric);
    // 增量更新聚合
    const a = this._agg.get(metric.toolName) || { totalLatency: 0, count: 0, errors: 0, cacheHits: 0 };
    a.totalLatency += metric.latency_ms;
    a.count++;
    if (!metric.ok) a.errors++;
    if (metric.cacheHit) a.cacheHits++;
    this._agg.set(metric.toolName, a);

    // 增量更新全局计数器
    this._totalLatency += metric.latency_ms;
    if (!metric.ok) this._totalErrors++;
    if (metric.cacheHit) this._totalCacheHits++;

    if (this.metrics.length > this.maxHistory) {
      this.metrics = this.metrics.slice(-this.maxHistory);
      this._aggDirty = true;
      this._globalDirty = true;
    }
  }

  /** 获取最近 N 次调用 */
  recent(n = 20): ToolCallMetric[] {
    return this.metrics.slice(-n).reverse();
  }

  private rebuildAgg() {
    this._agg.clear();
    for (const m of this.metrics) {
      const a = this._agg.get(m.toolName) || { totalLatency: 0, count: 0, errors: 0, cacheHits: 0 };
      a.totalLatency += m.latency_ms;
      a.count++;
      if (!m.ok) a.errors++;
      if (m.cacheHit) a.cacheHits++;
      this._agg.set(m.toolName, a);
    }
    this._aggDirty = false;
  }

  /** 按工具名聚合统计 */
  aggregate(): Map<string, { count: number; avgLatency: number; errorRate: string; cacheHitRate: string }> {
    if (this._aggDirty) this.rebuildAgg();

    const result = new Map<string, { count: number; avgLatency: number; errorRate: string; cacheHitRate: string }>();
    for (const [name, a] of this._agg) {
      result.set(name, {
        count: a.count,
        avgLatency: a.count > 0 ? Math.round(a.totalLatency / a.count) : 0,
        errorRate: a.count > 0 ? ((a.errors / a.count) * 100).toFixed(1) + "%" : "0%",
        cacheHitRate: a.count > 0 ? ((a.cacheHits / a.count) * 100).toFixed(1) + "%" : "0%",
      });
    }
    return result;
  }

  private rebuildGlobal() {
    this._totalLatency = 0;
    this._totalErrors = 0;
    this._totalCacheHits = 0;
    for (const m of this.metrics) {
      this._totalLatency += m.latency_ms;
      if (!m.ok) this._totalErrors++;
      if (m.cacheHit) this._totalCacheHits++;
    }
    this._globalDirty = false;
  }

  /** 全局统计 */
  summary() {
    if (this._globalDirty) this.rebuildGlobal();
    const total = this.metrics.length;
    const avgLatency = total > 0 ? Math.round(this._totalLatency / total) : 0;
    const uptimeMin = Math.round((Date.now() - this.startTime) / 60000);

    return {
      uptime_minutes: uptimeMin,
      total_calls: total,
      avg_latency_ms: avgLatency,
      error_rate: total > 0 ? ((this._totalErrors / total) * 100).toFixed(1) + "%" : "0%",
      cache_hit_rate: total > 0 ? ((this._totalCacheHits / total) * 100).toFixed(1) + "%" : "0%",
      by_tool: this.aggregate(),
    };
  }

  /** 通过工具注册 telemetry reporter */
  summaryText(): string {
    const s = this.summary();
    let text = `Uptime: ${s.uptime_minutes}min | Calls: ${s.total_calls} | Avg: ${s.avg_latency_ms}ms | Errors: ${s.error_rate} | Cache: ${s.cache_hit_rate}\n\n`;
    for (const [name, a] of s.by_tool) {
      text += `  ${name}: ${a.count} calls, avg ${a.avgLatency}ms, err ${a.errorRate}, cache ${a.cacheHitRate}\n`;
    }
    return text;
  }

  /** async iterable: 流式输出最近指标 */
  async *recentStream(n = 20): AsyncGenerator<string> {
    for (const m of this.recent(n)) {
      yield `${m.toolName}: ${m.latency_ms}ms ${m.ok ? "OK" : "FAIL"} ${m.cacheHit ? "(cached)" : ""}\n`;
    }
  }

  reset(): void {
    this.metrics = [];
    this._agg.clear();
    this._aggDirty = false;
    this._totalLatency = 0;
    this._totalErrors = 0;
    this._totalCacheHits = 0;
    this._globalDirty = false;
  }
}

export const telemetry = new TelemetryStore();
