/**
 * logger.ts 单元测试
 * 测试日志输出格式和级别过滤
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const _originalConsoleError = console.error;
let captured: string[] = [];

describe("logger", () => {
  beforeEach(async () => {
    captured = [];
    console.error = vi.fn((...args: any[]) => {
      captured.push(args.join(" "));
    });
    // 确保 info 级别
    process.env.MCP_LOG_LEVEL = "info";
    vi.resetModules();
  });

  test("logger.info 在 info 级别产生输出", async () => {
    const { logger } = await import("../../src/logger.js");
    logger.info("test-tool", "test-action", "detail");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("[INFO]");
    expect(captured[0]).toContain("[test-tool]");
    expect(captured[0]).toContain("test-action");
    expect(captured[0]).toContain("detail");
  });

  test("logger.info 无 detail 也可", async () => {
    const { logger } = await import("../../src/logger.js");
    captured = [];
    logger.info("tool", "action");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("[tool]");
    expect(captured[0]).toContain("action");
  });

  test("logger.debug 在 info 级别不输出", async () => {
    const { logger } = await import("../../src/logger.js");
    captured = [];
    logger.debug("tool", "action");
    expect(captured.length).toBe(0);
  });

  test("logger.warn 在 info 级别输出", async () => {
    const { logger } = await import("../../src/logger.js");
    captured = [];
    logger.warn("tool", "warning", "detail");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("[WARN]");
  });

  test("logger.error 在 info 级别输出", async () => {
    const { logger } = await import("../../src/logger.js");
    captured = [];
    logger.error("tool", "error", "fatal");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("[ERROR]");
    expect(captured[0]).toContain("fatal");
  });

  test("日志格式包含 ISO 时间戳", async () => {
    const { logger } = await import("../../src/logger.js");
    captured = [];
    logger.info("timing", "check");
    const msg = captured[0];
    // ISO 格式: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(msg).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });
});
