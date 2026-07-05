/**
 * safeguard.ts 扩展测试 — 包含 MCP Server mock
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// 保存原始环境变量
const originalSafetyMode = process.env.MCP_SAFETY_MODE;

describe("initSafeGuard", () => {
  beforeEach(() => {
    vi.resetModules();
    // 模拟 server
    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: class {},
      ResourceTemplate: class {},
    }));
  });

  afterEach(() => {
    if (originalSafetyMode) {
      process.env.MCP_SAFETY_MODE = originalSafetyMode;
    } else {
      delete process.env.MCP_SAFETY_MODE;
    }
  });

  test("initSafeGuard 默认模式为 normal", async () => {
    delete process.env.MCP_SAFETY_MODE;
    const { initSafeGuard, getSafetyMode } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("normal");
  });

  test("initSafeGuard 读取 MCP_SAFETY_MODE=strict", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, getSafetyMode } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("strict");
  });

  test("initSafeGuard 读取 MCP_SAFETY_MODE=off", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, getSafetyMode } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("off");
  });

  test("initSafeGuard 无效值回退到 normal", async () => {
    process.env.MCP_SAFETY_MODE = "invalid";
    const { initSafeGuard, getSafetyMode } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("normal");
  });
});

describe("guardDestructiveAction", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: class {},
      ResourceTemplate: class {},
    }));
  });

  afterEach(() => {
    if (originalSafetyMode) {
      process.env.MCP_SAFETY_MODE = originalSafetyMode;
    } else {
      delete process.env.MCP_SAFETY_MODE;
    }
  });

  test("guardDestructiveAction 在 off 模式直接放行", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toBeNull(); // null = 放行
  });

  test("guardDestructiveAction 在 strict 模式拦截受保护工具", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toContain("strict safety mode");
  });

  test("guardDestructiveAction 在 strict 模式放行非受保护工具", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    // read_file 不在 GUARDED_TOOLS 中
    const result = await guardDestructiveAction("read_file", "test read");
    expect(result).toBeNull();
  });

  test("guardDestructiveAction normal 模式下用户确认则放行", async () => {
    process.env.MCP_SAFETY_MODE = "normal";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const mockServer = {
      server: {
        elicitInput: vi.fn().mockResolvedValue({
          action: "accept",
          content: { confirm: true },
        }),
      },
    } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toBeNull();
  });

  test("guardDestructiveAction normal 模式下命令工具也需要确认", async () => {
    process.env.MCP_SAFETY_MODE = "normal";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { confirm: true },
    });
    const mockServer = {
      server: { elicitInput },
    } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("execute_command", "test command");
    expect(result).toBeNull();
    expect(elicitInput).toHaveBeenCalledOnce();
  });

  test("guardDestructiveAction normal 模式下用户取消则拒绝", async () => {
    process.env.MCP_SAFETY_MODE = "normal";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const mockServer = {
      server: {
        elicitInput: vi.fn().mockResolvedValue({
          action: "accept",
          content: { confirm: false },
        }),
      },
    } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toContain("cancelled");
  });

  test("guardDestructiveAction normal 模式下 Elicitation 抛出异常降级拒绝", async () => {
    process.env.MCP_SAFETY_MODE = "normal";
    const { initSafeGuard, guardDestructiveAction } = await import("./safeguard.js");
    const mockServer = {
      server: {
        elicitInput: vi.fn().mockRejectedValue(new Error("not supported")),
      },
    } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toContain("SAFETY");
    expect(result).toContain("Elicitation");
  });

  test("guardDestructiveAction 未初始化时返回错误", async () => {
    process.env.MCP_SAFETY_MODE = "normal";
    const { guardDestructiveAction } = await import("./safeguard.js");

    // 不调用 initSafeGuard — _server 为 null
    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toContain("not initialized");
  });
});
