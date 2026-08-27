/**
 * e2e 回归：risk-gated 命令分级确认（design 2026-08-28-command-risk-gated-confirmation §3）
 * 场景：off+risk-gated 下 ordinary 免确认执行、heavy/批量超限返回 ELICITATION_REQUIRED
 * （e2e 客户端不声明 elicitation 能力）、hardBlock 命中仍直接 COMMAND_DANGEROUS（A7）。
 * 依赖 build/index.js，先执行 pnpm run build。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, test } from "vitest";

const TEST_PARENT = path.resolve(".etmcp/test-tmp/command-risk-gated-e2e");

interface CallOutcome {
  isError: boolean;
  text: string;
}

async function withServer(
  env: Record<string, string>,
  cwd: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("build/index.js")],
    cwd,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "command-risk-gated-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close();
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
  return { isError: result.isError === true, text };
}

describe("command risk-gated e2e", () => {
  const projDir = path.join(TEST_PARENT, `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  afterAll(async () => {
    await fs.rm(TEST_PARENT, { recursive: true, force: true });
  });

  test("off+risk-gated：ordinary 免确认执行，heavy/超限批量 required，hardBlock 直接拒", async () => {
    await fs.mkdir(projDir, { recursive: true });
    await withServer({ MCP_SAFETY_MODE: "off", MCP_COMMAND_CONFIRMATION: "risk-gated" }, projDir, async (client) => {
      // 工具面：27 个且无 delete_preview（R2）
      const tools = await client.listTools();
      expect(tools.tools.length).toBe(27);
      expect(tools.tools.find((t) => t.name === "delete_preview")).toBeUndefined();

      // ordinary 免确认直接执行（A2/A12）
      const ordinary = await callTool(client, "execute_command", { command: "echo risk-gated-ordinary-ok" });
      expect(ordinary.isError).toBe(false);
      expect(ordinary.text).toContain("risk-gated-ordinary-ok");

      // heavy：客户端无 elicitation 能力 → ELICITATION_REQUIRED，不执行（A9/A12）
      const heavy = await callTool(client, "execute_command", { command: "rm -rf ./risk-gated-heavy-probe" });
      expect(heavy.isError).toBe(true);
      expect(heavy.text).toContain("ELICITATION_REQUIRED");

      // batch 6 条整批一次确认 → required，无部分执行（A5/A9）
      const batch = await callTool(client, "batch_execute", {
        commands: ["echo 1", "echo 2", "echo 3", "echo 4", "echo 5", "echo 6"],
      });
      expect(batch.isError).toBe(true);
      expect(batch.text).toContain("ELICITATION_REQUIRED");

      // hardBlock 命中在任何组合直接拒绝（A7）
      const hard = await callTool(client, "execute_command", { command: "rm -rf /" });
      expect(hard.isError).toBe(true);
      expect(hard.text).toMatch(/COMMAND_DANGEROUS|hard-blocked|dangerous/i);
    });
  });

  test("off（all 模式，未设新变量）：行为与现状一致，命令直接放行（A1/R3）", async () => {
    await fs.mkdir(projDir, { recursive: true });
    await withServer({ MCP_SAFETY_MODE: "off" }, projDir, async (client) => {
      const ordinary = await callTool(client, "execute_command", { command: "echo all-mode-ok" });
      expect(ordinary.isError).toBe(false);
      expect(ordinary.text).toContain("all-mode-ok");

      // all 模式下 heavy 分级不生效：6 条 echo 批量直接执行且全部成功（heavy 探针用无害命令，off 语义不变）
      const batch = await callTool(client, "batch_execute", {
        commands: ["echo 1", "echo 2", "echo 3", "echo 4", "echo 5", "echo 6"],
      });
      expect(batch.isError).toBe(false);
      expect(batch.text).toMatch(/all_ok|"allOk":true|All 6 commands OK|commands OK/i);
    });
  });
});
