/**
 * utility.ts 可测试逻辑单元测试
 */

import { describe, expect, test } from "vitest";
import {
  formatCacheInvalidateMessage,
  formatPoolStatsMessage,
  formatTelemetryText,
  formatTempStatsMessage,
  validateEnvKey,
  validateEnvValue,
} from "./utility.js";

describe("utility tools pure logic", () => {
  test("formatCacheInvalidateMessage for specific tool", () => {
    const msg = formatCacheInvalidateMessage("read_file", 3);
    expect(msg).toContain("read_file");
    expect(msg).toContain("3");
  });

  test("formatCacheInvalidateMessage for all caches", () => {
    const msg = formatCacheInvalidateMessage(undefined, 10);
    expect(msg).toContain("all caches");
    expect(msg).toContain("10");
  });

  test("validateEnvKey rejects invalid keys", () => {
    expect(validateEnvKey("")).toBe("invalid env key");
    expect(validateEnvKey("a=b")).toBe("invalid env key");
    expect(validateEnvKey("a".repeat(257))).toBe("invalid env key");
    expect(validateEnvKey("VALID_KEY")).toBeNull();
  });

  test("validateEnvValue rejects oversized values", () => {
    expect(validateEnvValue("a".repeat(32769))).toBe("env value too long");
    expect(validateEnvValue("ok")).toBeNull();
  });

  test("formatPoolStatsMessage", () => {
    const msg = formatPoolStatsMessage({ size: 2, max: 4, busy: 1, idle: 1 });
    expect(msg).toContain("2/4");
    expect(msg).toContain("1 busy");
    expect(msg).toContain("1 idle");
  });

  test("formatCacheStatsMessage", () => {
    // 导出已内联到 formatCacheInvalidateMessage，这里验证 stats 格式化函数存在
    const msg = formatTempStatsMessage({
      total_dirs: 5,
      total_size_bytes: 1024,
      oldest_dir_ms: 100,
      newest_dir_ms: 10,
      removed_count: 2,
    });
    expect(msg).toContain("5");
    expect(msg).toContain("1024");
    expect(msg).toContain("100ms");
    expect(msg).toContain("2");
  });

  test("formatTelemetryText includes summary and audit", () => {
    const summary = {
      uptime_minutes: 1,
      total_calls: 10,
      avg_latency_ms: 20,
      error_rate: "0%",
      cache_hit_rate: "50%",
    };
    const text = formatTelemetryText(
      summary,
      [],
      { total_dirs: 1, total_size_bytes: 0, oldest_dir_ms: 0, newest_dir_ms: 0, removed_count: 0 },
      { mode: "errors", enabled: true },
    );
    expect(text).toContain("Uptime: 1min");
    expect(text).toContain("Calls: 10");
    expect(text).toContain("Audit: mode=errors");
  });
});
