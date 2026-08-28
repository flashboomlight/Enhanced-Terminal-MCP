/**
 * 工具 surface 一致性 e2e（子进程真实 server）
 *
 * 两种配置（默认 / ENHANCED_TERMINAL_DISABLE_FILE_INFO=1）下断言：
 * 1. tools/list 数量 27/26；2. usage-guide prompt 文本计数一致；
 * 3. health://status 的 tools.enabled/disabled 一致；
 * 4. pool_stats.active=false（PRO-02 诚实 stub 证据）；
 * 5. session_state 缺 cwd 走 MCP 全链路返回 VALIDATION_ERROR（不静默 no-op）。
 */
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

async function withServer<T>(disableFileInfo: boolean, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("build/index.js")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_SAFETY_MODE: "off",
      MCP_STATE_DIR: path.resolve(".etmcp/test-tmp/tool-visibility"),
      ENHANCED_TERMINAL_DISABLE_FILE_INFO: disableFileInfo ? "1" : "0",
    },
  });
  const client = new Client({ name: "tool-visibility-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function collectSurface(client: Client) {
  const tools = await client.listTools();
  const prompt = await client.getPrompt({ name: "usage-guide" });
  const healthResource = await client.readResource({ uri: "health://status" });
  const health = JSON.parse((healthResource.contents[0] as { text: string }).text) as {
    status: string;
    components: Record<string, { state: string }>;
    tools: { enabled: number; disabled: number };
  };
  const telemetry = await client.callTool({ name: "telemetry_report", arguments: {} });
  const pool = await client.callTool({ name: "pool_stats", arguments: {} });
  const missingCwd = await client.callTool({ name: "session_state", arguments: { action: "set_cwd" } });

  const promptText = (prompt.messages[0]?.content as { type: string; text: string } | undefined)?.text ?? "";
  return {
    count: tools.tools.length,
    names: tools.tools.map((tool) => tool.name),
    promptText,
    health,
    auditStateText: (
      (telemetry.content as Array<{ type: string; text?: string }> | undefined)?.[0]?.text ?? ""
    ).includes("state="),
    poolActive: (pool.structuredContent as { active?: boolean } | undefined)?.active,
    missingCwdIsError: missingCwd.isError === true,
    missingCwdCode: (missingCwd.structuredContent as { error?: { code?: string } } | undefined)?.error?.code,
  };
}

describe("tool surface consistency (27/26)", () => {
  test("default config: 27 tools consistent across tools/list, prompt, and health", async () => {
    const surface = await withServer(false, collectSurface);

    expect(surface.count).toBe(27);
    expect(surface.names).toContain("file_info");
    expect(surface.names).not.toContain("delete_preview");
    expect(surface.promptText).toContain("provides 27 tools");
    expect(surface.health.tools).toEqual({ enabled: 27, disabled: 0 });
    // truthful health（production-hardening #8）：status 不再恒为 ok，四组件齐全
    expect(["healthy", "degraded", "failed"]).toContain(surface.health.status);
    expect(Object.keys(surface.health.components).sort()).toEqual(["audit", "process", "session", "temp"]);
    expect(surface.auditStateText).toBe(true);
    expect(surface.poolActive).toBe(false);
    expect(surface.missingCwdIsError).toBe(true);
    expect(surface.missingCwdCode).toBe("VALIDATION_ERROR");
  });

  test("file_info disabled: 26 tools consistent across tools/list, prompt, and health", async () => {
    const surface = await withServer(true, collectSurface);

    expect(surface.count).toBe(26);
    expect(surface.names).not.toContain("file_info");
    expect(surface.promptText).toContain("provides 26 tools");
    expect(surface.health.tools).toEqual({ enabled: 26, disabled: 1 });
  });
});
