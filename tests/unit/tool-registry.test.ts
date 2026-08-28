/**
 * tool-registry.ts 单元测试 —— 真实启用计数（PRO-01）
 *
 * 计数唯一真源是 SDK RegisteredTool.enabled 标志；
 * 这里用 fake server 验证 registerManagedTool 记账与 disable/enable 联动。
 */
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, test } from "vitest";
import {
  getAllRegisteredToolNames,
  getEnabledToolNames,
  getRegisteredToolCount,
  registerManagedTool,
  resetToolRegistryForTests,
} from "../../src/tool-registry.js";

type FakeRegistered = Pick<RegisteredTool, "enabled" | "enable" | "disable">;

/** 构造只实现 registerTool 的 fake McpServer，记录传入的 name/config/handler */
function fakeServer(store: Map<string, FakeRegistered>, calls: Array<{ name: string; config: unknown; cb: unknown }>) {
  return {
    registerTool(name: string, config: unknown, cb: unknown) {
      calls.push({ name, config, cb });
      const tool: FakeRegistered = {
        enabled: true,
        enable() {
          this.enabled = true;
        },
        disable() {
          this.enabled = false;
        },
      };
      store.set(name, tool);
      return tool;
    },
  } as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
}

const noopHandler = async () => ({ content: [] }) as never;

describe("tool registry (real enabled count)", () => {
  beforeEach(() => resetToolRegistryForTests());

  test("registers through the server and records the handle", () => {
    const store = new Map<string, FakeRegistered>();
    const calls: Array<{ name: string; config: unknown; cb: unknown }> = [];
    const server = fakeServer(store, calls);

    const config = { description: "d" };
    const tool = registerManagedTool(server, "tool_a", config, noopHandler);

    expect(calls).toEqual([{ name: "tool_a", config, cb: noopHandler }]);
    expect(getRegisteredToolCount()).toBe(1);
    expect(getEnabledToolNames()).toEqual(["tool_a"]);
    expect(tool).toBe(store.get("tool_a"));
  });

  test("disable/enable on the SDK handle is reflected by the count immediately", () => {
    const store = new Map<string, FakeRegistered>();
    const server = fakeServer(store, []);
    const a = registerManagedTool(server, "tool_a", {}, noopHandler);
    registerManagedTool(server, "tool_b", {}, noopHandler);

    expect(getRegisteredToolCount()).toBe(2);
    a.disable();
    expect(getRegisteredToolCount()).toBe(1);
    expect(getEnabledToolNames()).toEqual(["tool_b"]);
    expect(getAllRegisteredToolNames()).toEqual(["tool_a", "tool_b"]);

    a.enable();
    expect(getRegisteredToolCount()).toBe(2);
    expect(getEnabledToolNames()).toEqual(["tool_a", "tool_b"]);
  });

  test("empty registry reports zero", () => {
    expect(getRegisteredToolCount()).toBe(0);
    expect(getEnabledToolNames()).toEqual([]);
    expect(getAllRegisteredToolNames()).toEqual([]);
  });
});
