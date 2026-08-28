/**
 * utility.ts 可测试逻辑单元测试
 */

import { describe, expect, test } from "vitest";
import {
  computeHealthStatus,
  formatCacheInvalidateMessage,
  formatPoolStatsMessage,
  formatTelemetryText,
  formatTempStatsMessage,
  registerUtilityTools,
  validateEnvKey,
  validateEnvValue,
} from "../../../src/tools/utility.js";

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

  test("validateEnvKey rejects persistence deny list case-insensitively", () => {
    expect(validateEnvKey("path")).toMatch(/denied/);
    expect(validateEnvKey("Node_Options")).toMatch(/denied/);
    expect(validateEnvKey("PATH")).toMatch(/denied/);
  });

  test("validateEnvValue rejects oversized values", () => {
    expect(validateEnvValue("a".repeat(32769))).toBe("env value too long");
    expect(validateEnvValue("ok")).toBeNull();
  });

  test("formatPoolStatsMessage", () => {
    const msg = formatPoolStatsMessage({ size: 2, max: 4, busy: 1, idle: 1, active: false });
    expect(msg).toContain("2/4");
    expect(msg).toContain("1 busy");
    expect(msg).toContain("1 idle");
    expect(msg).toContain("inactive");
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

/**
 * session_state action 缺参显式拒绝（fake server 直调，同 system.test.ts 惯例）。
 * 只覆盖拒绝路径，成功路径由 e2e 与进程内会话测试覆盖。
 */
describe("session_state action-dependent validation", () => {
  function registerUtility() {
    const tools = new Map<string, { handler: (args: Record<string, unknown>) => Promise<any> }>();
    const server = {
      registerTool(name: string, _spec: unknown, handler: (args: Record<string, unknown>) => Promise<any>) {
        tools.set(name, { handler });
      },
      resource: () => {},
      prompt: () => {},
    };
    registerUtilityTools(server as any);
    return tools;
  }

  test("set_cwd without cwd is rejected, not silently no-op", async () => {
    const result = await registerUtility().get("session_state")?.handler({ action: "set_cwd" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "cwd" });
  });

  test("set_env without key is rejected with param=key", async () => {
    const result = await registerUtility().get("session_state")?.handler({ action: "set_env", value: "v" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "key" });
  });

  test("set_env without value is rejected with param=value", async () => {
    const result = await registerUtility().get("session_state")?.handler({ action: "set_env", key: "MY_KEY" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "value" });
  });
});

describe("truthful health aggregation", () => {
  const components = (audit: string, temp = "healthy", process = "healthy", session = "healthy") => ({
    audit: { state: audit },
    temp: { state: temp },
    process: { state: process },
    session: { state: session },
  });

  test("all healthy components aggregate to healthy", () => {
    expect(computeHealthStatus(components("healthy"))).toBe("healthy");
  });

  test("any degraded component aggregates to degraded", () => {
    expect(computeHealthStatus(components("degraded"))).toBe("degraded");
    expect(computeHealthStatus(components("healthy", "degraded"))).toBe("degraded");
    expect(computeHealthStatus(components("healthy", "healthy", "degraded"))).toBe("degraded");
    expect(computeHealthStatus(components("healthy", "healthy", "healthy", "degraded"))).toBe("degraded");
  });

  test("failed dominates degraded", () => {
    expect(computeHealthStatus(components("degraded", "degraded", "failed", "degraded"))).toBe("failed");
    expect(computeHealthStatus(components("failed"))).toBe("failed");
  });

  test("telemetry text includes the audit state", () => {
    const text = formatTelemetryText(
      { uptime_minutes: 1, total_calls: 2, avg_latency_ms: 3, error_rate: "0%", cache_hit_rate: "0%" },
      [],
      {
        total_dirs: 0,
        total_size_bytes: 0,
        oldest_dir_ms: 0,
        newest_dir_ms: 0,
        removed_count: 0,
        active_dirs: 0,
        reserved_bytes: 0,
      },
      { mode: "errors", enabled: true },
      "healthy",
    );
    expect(text).toContain("state=healthy");
  });
});
