import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, test } from "vitest";

async function listToolNames(disableFileInfo: boolean): Promise<string[]> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("build/index.js")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_SAFETY_MODE: "off",
      ENHANCED_TERMINAL_DISABLE_FILE_INFO: disableFileInfo ? "1" : "0",
    },
  });
  const client = new Client({ name: "tool-visibility-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    return result.tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

describe("conditional tool registration", () => {
  test("file_info is enabled by default", async () => {
    const names = await listToolNames(false);

    expect(names).toContain("file_info");
    expect(names).toHaveLength(28);
  });

  test("file_info is hidden when explicitly disabled", async () => {
    const names = await listToolNames(true);

    expect(names).not.toContain("file_info");
    expect(names).toHaveLength(27);
  });
});
