/**
 * adaptive.ts 真实 P95 超时单元测试
 */

import { beforeEach, describe, expect, test } from "vitest";
import { adaptiveTimeout } from "../../src/adaptive.js";
import { telemetry } from "../../src/telemetry.js";

/** 往 telemetry 录样本（默认非 cache-hit） */
function recordSamples(toolName: string, latencies: number[], cacheHit = false) {
  for (const latency_ms of latencies) {
    telemetry.record({ toolName, latency_ms, ok: true, cacheHit, timestamp: Date.now() });
  }
}

describe("adaptiveTimeout", () => {
  beforeEach(() => {
    telemetry.reset();
  });

  test("falls back to base when samples < 5", () => {
    recordSamples("execute_command", [10, 20, 30, 40]);
    expect(adaptiveTimeout("execute_command", 30000)).toBe(30000);
  });

  test("uses nearest-rank P95 of skewed samples", () => {
    // 18×10ms + 2×5000ms（n=20）→ 第 ceil(0.95×20)=19 名（1-based）= 5000
    recordSamples("execute_command", [...Array(18).fill(10), 5000, 5000]);
    // P95×3 = 15000 > base 5000 且 < 4×base → 取 15000
    expect(adaptiveTimeout("execute_command", 5000)).toBe(15000);
  });

  test("caps adaptive at 4× base", () => {
    recordSamples("execute_command", [...Array(18).fill(10), 5000, 5000]);
    // P95×3 = 15000 > 4×1000 → 上限截断 4000
    expect(adaptiveTimeout("execute_command", 1000)).toBe(4000);
  });

  test("base wins when P95×3 is below base", () => {
    recordSamples("execute_command", [...Array(18).fill(10), 5000, 5000]);
    // P95×3 = 15000 < 30000 → base 兜底
    expect(adaptiveTimeout("execute_command", 30000)).toBe(30000);
  });

  test("uniform samples yield P95 of the sample value", () => {
    recordSamples("execute_command", [100, 100, 100, 100, 100]);
    // P95=100 → adaptive=300 < base 1000 → base
    expect(adaptiveTimeout("execute_command", 1000)).toBe(1000);
    // base 100 → max(100, min(300, 400)) = 300
    expect(adaptiveTimeout("execute_command", 100)).toBe(300);
  });

  test("cache-hit samples are excluded", () => {
    // 5 条 cacheHit 长延迟不计入；非 cache 样本仅 4 条 <5 → 回退 base
    recordSamples("execute_command", [9000, 9000, 9000, 9000, 9000], true);
    recordSamples("execute_command", [10, 10, 10, 10]);
    expect(adaptiveTimeout("execute_command", 30000)).toBe(30000);
  });

  test("unknown tool falls back to default base", () => {
    expect(adaptiveTimeout("some_unknown_tool")).toBe(30000);
  });
});
