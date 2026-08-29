import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_TEST_ROOT, resultErrorCode, resultText, startMcpServer } from "./support/mcp-server.js";

const TEST_ROOT = path.join(MCP_TEST_ROOT, "platform");
const WORK_ROOT = path.join(TEST_ROOT, "work");
const SMOKE_FILE = path.join(WORK_ROOT, "platform-smoke.txt");

beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(WORK_ROOT, { recursive: true });
  await fs.writeFile(SMOKE_FILE, "platform-smoke-marker\n", "utf8");
});

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("cross-platform MCP smoke", () => {
  test("runs the minimum stdio, file, command, search, system, and error paths", async () => {
    const connection = await startMcpServer({}, {}, TEST_ROOT);
    try {
      const listed = await connection.client.listTools();
      expect(listed.tools).toHaveLength(27);

      const file = await connection.client.callTool({
        name: "read_file",
        arguments: { file_path: SMOKE_FILE },
      });
      expect(file.isError).not.toBe(true);
      expect(resultText(file)).toContain("platform-smoke-marker");

      const command = await connection.client.callTool({
        name: "execute_command",
        arguments: { command: "echo platform-smoke-ok" },
      });
      expect(command.isError).not.toBe(true);
      expect(resultText(command)).toContain("platform-smoke-ok");

      const search = await connection.client.callTool({
        name: "search_files",
        arguments: { dir_path: WORK_ROOT, pattern: "*.txt", max_results: 5 },
      });
      expect(search.isError).not.toBe(true);
      expect(resultText(search)).toContain("platform-smoke.txt");

      const grep = await connection.client.callTool({
        name: "grep_content",
        arguments: { dir_path: WORK_ROOT, pattern: "platform-smoke-marker", file_pattern: "*.txt", max_results: 5 },
      });
      expect(grep.isError).not.toBe(true);
      expect(resultText(grep)).toContain("platform-smoke-marker");

      const system = await connection.client.callTool({ name: "get_system_info", arguments: {} });
      expect(system.isError).not.toBe(true);
      expect(typeof resultText(system)).toBe("string");

      const network = await connection.client.callTool({
        name: "network_info",
        arguments: { action: "config" },
      });
      expect(network.isError).not.toBe(true);

      const blocked = await connection.client.callTool({
        name: "read_file",
        arguments: { file_path: "../../etc/passwd" },
      });
      expect(blocked.isError).toBe(true);
      expect(resultErrorCode(blocked)).toBe("PATH_FORBIDDEN");

      const health = await connection.client.readResource({ uri: "health://status" });
      expect(JSON.parse((health.contents[0] as { text: string }).text).status).toMatch(/^(healthy|degraded|failed)$/);
    } finally {
      await connection.close();
    }
  }, 30000);
});
