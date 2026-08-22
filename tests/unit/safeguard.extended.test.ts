/**
 * safeguard.ts 扩展测试 — 包含 MCP Server mock
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// 保存原始环境变量
const originalSafetyMode = process.env.MCP_SAFETY_MODE;
const originalConfirmationMode = process.env.MCP_CONFIRMATION_MODE;

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
    const { initSafeGuard, getSafetyMode } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("normal");
  });

  test("initSafeGuard 读取 MCP_SAFETY_MODE=strict", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, getSafetyMode } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("strict");
  });

  test("initSafeGuard 读取 MCP_SAFETY_MODE=off", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, getSafetyMode } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);
    expect(getSafetyMode()).toBe("off");
  });

  test("initSafeGuard 无效值回退到 normal", async () => {
    process.env.MCP_SAFETY_MODE = "invalid";
    const { initSafeGuard, getSafetyMode } = await import("../../src/safeguard.js");
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
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toBeNull(); // null = 放行
  });

  test("guardDestructiveAction 在 strict 模式拦截受保护工具", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toContain("strict safety mode");
  });

  test("guardDestructiveAction 在 strict 模式拦截文件写入型工具", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    for (const tool of ["copy_move", "compress_archive", "extract_archive", "download_file"]) {
      const result = await guardDestructiveAction(tool, "test write");
      expect(result).toContain("strict safety mode");
    }
  });

  test("guardDestructiveAction 在 strict 模式放行非受保护工具", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    const mockServer = { server: { elicitInput: vi.fn() } } as any;
    initSafeGuard(mockServer);

    // read_file 不在 GUARDED_TOOLS 中
    const result = await guardDestructiveAction("read_file", "test read");
    expect(result).toBeNull();
  });

  test("guardDestructiveAction normal 模式下用户确认则放行", async () => {
    process.env.MCP_SAFETY_MODE = "normal";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
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
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
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
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
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
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
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
    const { guardDestructiveAction } = await import("../../src/safeguard.js");

    // 不调用 initSafeGuard — _server 为 null
    const result = await guardDestructiveAction("delete_path", "test delete");
    expect(result).toContain("not initialized");
  });
});

describe("headless surface 优先级与审计", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
      McpServer: class {},
      ResourceTemplate: class {},
    }));
  });

  afterEach(() => {
    for (const [key, value] of [
      ["MCP_SAFETY_MODE", originalSafetyMode],
      ["MCP_CONFIRMATION_MODE", originalConfirmationMode],
    ] as const) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  test("off+headless 下非 delete 受保护工具被 headless surface 拦截", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    process.env.MCP_CONFIRMATION_MODE = "headless";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    for (const tool of ["execute_command", "batch_execute", "watch_command", "copy_move", "kill_process"]) {
      expect(await guardDestructiveAction(tool, "test")).toContain("headless workspace-delete surface");
    }
  });

  test("off+headless 下 delete_path 仍放行（headless allow，边界由 preview 流约束）", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    process.env.MCP_CONFIRMATION_MODE = "headless";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    expect(await guardDestructiveAction("delete_path", "test delete")).toBeNull();
  });

  test("strict+headless 下 delete_path 被 strict 拦截（strict 优先于确认通道）", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    process.env.MCP_CONFIRMATION_MODE = "headless";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    expect(await guardDestructiveAction("delete_path", "test delete")).toContain("strict safety mode");
  });

  test("纯 off（未设确认通道）下命令工具仍直接放行", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    delete process.env.MCP_CONFIRMATION_MODE;
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    expect(await guardDestructiveAction("execute_command", "test command")).toBeNull();
  });

  test("非 allow 决策统一写入 safety.decision 审计", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "normal";
    process.env.MCP_CONFIRMATION_MODE = "headless";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    await guardDestructiveAction("execute_command", "test command");

    expect(recordSpy).toHaveBeenCalledOnce();
    const entry = recordSpy.mock.calls[0][0] as Record<string, any>;
    expect(entry.action).toBe("safety.decision");
    expect(entry.tool).toBe("execute_command");
    expect(entry.success).toBe(false);
    expect(entry.detail).toMatchObject({
      decision: "blocked",
      reason: "headless_surface",
      confirmation_mode: "headless",
      error_code: "SAFETY_BLOCKED",
    });
  });

  test("用户取消（declined）审计记录 ELICITATION_CANCELLED", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "normal";
    delete process.env.MCP_CONFIRMATION_MODE;
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({
      server: { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { confirm: false } }) },
    } as any);

    await guardDestructiveAction("delete_path", "test delete");

    const entry = recordSpy.mock.calls[0][0] as Record<string, any>;
    expect(entry.detail).toMatchObject({
      decision: "declined",
      source: "elicitation",
      error_code: "ELICITATION_CANCELLED",
    });
  });

  test("allow 决策不写入 safety.decision 审计（成功路径由各工具自记）", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "off";
    delete process.env.MCP_CONFIRMATION_MODE;
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    await guardDestructiveAction("execute_command", "test command");
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
