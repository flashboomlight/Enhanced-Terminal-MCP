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

describe("risk-gated 分级与审计", () => {
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
    delete process.env.MCP_COMMAND_CONFIRMATION;
  });

  test("off 下 ordinary 命令免确认放行且不调用 elicitInput（A2/A12）", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    const elicitInput = vi.fn();
    initSafeGuard({ server: { elicitInput } } as any);

    const { decision } = await guardCommandByRisk("execute_command", "echo hello", { tool: "execute_command" });
    expect(decision.status).toBe("allow");
    expect(elicitInput).not.toHaveBeenCalled();
  });

  test("off 下 heavy 命令仍需确认：无能力时返回 required（A9/A12）", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    // getClientCapabilities 返回空对象 → 声明不支持 form Elicitation
    initSafeGuard({
      server: { elicitInput: vi.fn(), getClientCapabilities: () => ({}) },
    } as any);

    const { decision, risk } = await guardCommandByRisk("execute_command", "rm -rf ./node_modules/.cache", {
      tool: "execute_command",
    });
    expect(decision).toMatchObject({ status: "required", reason: "elicitation", clientSupportsElicitation: false });
    expect(risk).toMatchObject({ level: "heavy", category: "destructive" });
  });

  test("heavy 确认消息包含风险原因（A6）", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    const elicitInput = vi.fn().mockResolvedValue({ action: "accept", content: { confirm: true } });
    initSafeGuard({ server: { elicitInput } } as any);

    await guardCommandByRisk("execute_command", "rm -rf ./node_modules/.cache", { tool: "execute_command" });
    const message = elicitInput.mock.calls[0][0].message as string;
    expect(message).toContain("破坏类操作");
    expect(message).toContain("rm -rf ./node_modules/.cache");
  });

  test("heavy 用户确认 → allow 且审计含 risk 字段（A10）", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    initSafeGuard({
      server: { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { confirm: true } }) },
    } as any);

    const { decision } = await guardCommandByRisk("execute_command", "rm -rf ./x", { tool: "execute_command" });
    expect(decision.status).toBe("allow");

    const entry = recordSpy.mock.calls[0][0] as Record<string, any>;
    expect(entry.action).toBe("safety.decision");
    expect(entry.success).toBe(true);
    expect(entry.detail).toMatchObject({ decision: "allow", risk_level: "heavy", risk_category: "destructive" });
    expect(JSON.stringify(entry.detail)).not.toContain("rm -rf ./x");
  });

  test("heavy 用户取消 → declined 且审计 ELICITATION_CANCELLED（A10）", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    initSafeGuard({
      server: { elicitInput: vi.fn().mockResolvedValue({ action: "accept", content: { confirm: false } }) },
    } as any);

    const { decision } = await guardCommandByRisk("execute_command", "pnpm install", { tool: "execute_command" });
    expect(decision.status).toBe("declined");

    const entry = recordSpy.mock.calls[0][0] as Record<string, any>;
    expect(entry.detail).toMatchObject({
      decision: "decline",
      risk_level: "heavy",
      risk_category: "performance",
      error_code: "ELICITATION_CANCELLED",
    });
  });

  test("batch 6 条整批一次确认且分类为 batch（A5）", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    const elicitInput = vi.fn().mockResolvedValue({ action: "accept", content: { confirm: true } });
    initSafeGuard({ server: { elicitInput } } as any);

    const commands = ["echo 1", "echo 2", "echo 3", "echo 4", "echo 5", "echo 6"];
    const { decision, risk } = await guardCommandByRisk("batch_execute", "", {
      tool: "batch_execute",
      batchCommands: commands,
    });
    expect(decision.status).toBe("allow");
    expect(risk).toMatchObject({ level: "heavy", category: "batch" });
    expect(elicitInput).toHaveBeenCalledOnce();
    const message = elicitInput.mock.calls[0][0].message as string;
    expect(message).toContain("批量 6 条");
  });

  test("strict 优先于分级：heavy 命令被 strict 拦截（A11）", async () => {
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardCommandByRisk } = await import("../../src/safeguard.js");
    const elicitInput = vi.fn();
    initSafeGuard({ server: { elicitInput } } as any);

    const { decision } = await guardCommandByRisk("execute_command", "rm -rf ./x", { tool: "execute_command" });
    expect(decision).toMatchObject({ status: "blocked", reason: "strict" });
    expect(elicitInput).not.toHaveBeenCalled();
  });

  test("纯 off（risk-gated 未开）下 guardDestructiveAction 仍直接放行（A1/R3）", async () => {
    process.env.MCP_SAFETY_MODE = "off";
    delete process.env.MCP_COMMAND_CONFIRMATION;
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    expect(await guardDestructiveAction("execute_command", "test command")).toBeNull();
  });

  test("strict 阻断写入 safety.decision 审计（非 allow 决策统一审计）", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "strict";
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    await guardDestructiveAction("execute_command", "test command");

    const entry = recordSpy.mock.calls[0][0] as Record<string, any>;
    expect(entry.action).toBe("safety.decision");
    expect(entry.success).toBe(false);
    expect(entry.detail).toMatchObject({ decision: "blocked", reason: "strict", error_code: "SAFETY_BLOCKED" });
  });

  test("用户取消（declined）审计记录 ELICITATION_CANCELLED", async () => {
    const recordSpy = vi.fn();
    vi.doMock("../../src/audit.js", () => ({ audit: { record: recordSpy } }));
    process.env.MCP_SAFETY_MODE = "normal";
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
    const { initSafeGuard, guardDestructiveAction } = await import("../../src/safeguard.js");
    initSafeGuard({ server: { elicitInput: vi.fn() } } as any);

    await guardDestructiveAction("execute_command", "test command");
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
