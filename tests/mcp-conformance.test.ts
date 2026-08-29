import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterAll, describe, expect, test } from "vitest";
import {
  delay,
  MCP_TEST_ROOT,
  resultErrorCode,
  resultText,
  runServerUntilExit,
  startMcpServer,
} from "./support/mcp-server.js";

const TEST_ROOT = path.join(MCP_TEST_ROOT, "conformance");

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

/** 启动归属于本 suite 的隔离 MCP server。 */
function startConformanceServer(
  overrides: Record<string, string> = {},
  clientOptions: ConstructorParameters<typeof Client>[1] = {},
) {
  return startMcpServer(overrides, clientOptions, TEST_ROOT);
}

/** 对 MCP client 调用结果做统一的安全断言。 */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** 启动一个长运行但无副作用的 Node 命令，用于 cancellation/disconnect 场景。 */
function longRunningCommand(): string {
  return 'node -e "setTimeout(() => {}, 10000)"';
}

describe("MCP protocol conformance", () => {
  test("initialize and tools/list expose a valid 27-tool surface", async () => {
    const connection = await startConformanceServer();
    try {
      expect(connection.client.getServerVersion()).toMatchObject({
        name: "enhanced-terminal-mcp",
        version: expect.any(String),
      });
      const capabilities = connection.client.getServerCapabilities();
      expect(capabilities?.tools).toBeDefined();
      expect(capabilities?.resources).toBeDefined();
      expect(capabilities?.prompts).toBeDefined();

      const listed = await connection.client.listTools();
      expect(listed.tools).toHaveLength(27);
      const names = listed.tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(27);
      expect(names).not.toContain("delete_preview");

      for (const tool of listed.tools) {
        const inputSchema = asRecord(tool.inputSchema);
        const outputSchema = asRecord(tool.outputSchema);
        expect(inputSchema.type, `${tool.name} input schema`).toBe("object");
        expect(outputSchema.type, `${tool.name} output schema`).toBe("object");
        expect(Array.isArray(inputSchema.required), `${tool.name} input required`).toBe(true);
        expect(typeof tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBe("boolean");
        expect(typeof tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBe("boolean");
        expect(typeof tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBe("boolean");
      }
    } finally {
      await connection.close();
    }
  });

  test("file_info visibility stays consistent across tools/list and health", async () => {
    const connection = await startConformanceServer({ ENHANCED_TERMINAL_DISABLE_FILE_INFO: "1" });
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools).toHaveLength(26);
      expect(listed.tools.map((tool) => tool.name)).not.toContain("file_info");

      const resource = await connection.client.readResource({ uri: "health://status" });
      const health = JSON.parse((resource.contents[0] as { text: string }).text) as {
        tools: { enabled: number; disabled: number };
      };
      expect(health.tools).toEqual({ enabled: 26, disabled: 1 });
    } finally {
      await connection.close();
    }
  });

  test("resources, resource templates, and prompts follow MCP result shapes", async () => {
    const connection = await startConformanceServer();
    try {
      const resources = await connection.client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("audit://log");

      const templates = await connection.client.listResourceTemplates();
      expect(templates.resourceTemplates.some((item) => item.uriTemplate === "health://status")).toBe(true);
      expect(templates.resourceTemplates.some((item) => item.uriTemplate.includes("audit://log"))).toBe(true);

      const health = await connection.client.readResource({ uri: "health://status" });
      const healthPayload = JSON.parse((health.contents[0] as { text: string }).text) as Record<string, unknown>;
      expect(["healthy", "degraded", "failed"]).toContain(healthPayload.status);
      expect(asRecord(healthPayload.tools).enabled).toBe(27);

      const audit = await connection.client.readResource({ uri: "audit://log?limit=1" });
      expect(Array.isArray(JSON.parse((audit.contents[0] as { text: string }).text))).toBe(true);

      const prompts = await connection.client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(["usage-guide", "safety-info"]);
      for (const name of ["usage-guide", "safety-info"]) {
        const prompt = await connection.client.getPrompt({ name });
        expect(prompt.messages.length).toBeGreaterThan(0);
        expect(prompt.messages[0]?.role).toBe("user");
        expect((prompt.messages[0]?.content as { type?: string }).type).toBe("text");
      }
    } finally {
      await connection.close();
    }
  });

  test("successful and error tools/call results satisfy structured output contracts", async () => {
    const connection = await startConformanceServer();
    try {
      const telemetry = await connection.client.callTool({ name: "telemetry_report", arguments: { recent: 1 } });
      expect(telemetry.isError).not.toBe(true);
      expect(typeof asRecord(telemetry.structuredContent).summary).toBe("string");

      const command = await connection.client.callTool({
        name: "execute_command",
        arguments: { command: "echo mcp-conformance-ok" },
      });
      expect(command.isError).not.toBe(true);
      expect(resultText(command)).toContain("mcp-conformance-ok");
      expect(asRecord(command.structuredContent).ok).toBe(true);

      const missingField = await connection.client.callTool({
        name: "session_state",
        arguments: { action: "set_cwd" },
      });
      expect(missingField.isError).toBe(true);
      expect(resultErrorCode(missingField)).toBe("VALIDATION_ERROR");
      expect(asRecord(asRecord(missingField.structuredContent).error).param).toBe("cwd");

      const pool = await connection.client.callTool({ name: "pool_stats", arguments: {} });
      expect(asRecord(pool.structuredContent).active).toBe(false);
    } finally {
      await connection.close();
    }
  });

  test("risk-gated heavy commands and hardBlock keep their explicit error semantics", async () => {
    const connection = await startConformanceServer({ MCP_COMMAND_CONFIRMATION: "risk-gated" });
    try {
      const heavy = await connection.client.callTool({
        name: "batch_execute",
        arguments: { commands: ["echo 1", "echo 2", "echo 3", "echo 4", "echo 5", "echo 6"] },
      });
      expect(heavy.isError).toBe(true);
      expect(resultErrorCode(heavy)).toBe("ELICITATION_REQUIRED");

      const hardBlocked = await connection.client.callTool({
        name: "execute_command",
        arguments: { command: "rm -rf /" },
      });
      expect(hardBlocked.isError).toBe(true);
      expect(resultText(hardBlocked)).toMatch(/COMMAND_DANGEROUS|hard-blocked|dangerous/i);
    } finally {
      await connection.close();
    }
  });

  test("sandboxed-production fails closed when no backend is available", async () => {
    const exited = await runServerUntilExit({ MCP_EXECUTION_PROFILE: "sandboxed-production" }, 5000, TEST_ROOT);
    expect(exited.code).not.toBe(0);
    expect(exited.stderr).toContain("SANDBOX_UNAVAILABLE");
  });

  test("MCP cancellation settles a running command and leaves the server responsive", async () => {
    const connection = await startConformanceServer();
    try {
      const controller = new AbortController();
      const pending = connection.client.callTool(
        {
          name: "watch_command",
          arguments: { command: longRunningCommand(), duration: 600000 },
        },
        undefined,
        { signal: controller.signal },
      );
      await delay(150);
      controller.abort();
      const settled = await Promise.race([
        pending.then(
          () => "resolved",
          () => "rejected",
        ),
        delay(5000).then(() => "timeout"),
      ]);
      expect(settled).not.toBe("timeout");

      const telemetry = await connection.client.callTool({ name: "telemetry_report", arguments: {} });
      expect(telemetry.isError).not.toBe(true);
    } finally {
      await connection.close();
    }
  });

  test("client disconnect closes a running stdio session within the bounded transport window", async () => {
    const connection = await startConformanceServer();
    const pending = connection.client.callTool({
      name: "watch_command",
      arguments: { command: longRunningCommand(), duration: 600000 },
    });
    await delay(150);
    await Promise.race([connection.client.close(), delay(5000).then(() => "timeout")]).then((result) => {
      expect(result).not.toBe("timeout");
    });
    await pending.catch(() => undefined);
    await connection.close();
  });
});
