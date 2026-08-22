import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeEach, describe, expect, test } from "vitest";

const TEST_PARENT = path.resolve(".etmcp/test-tmp/workspace-delete");
const WORKSPACE_ROOT = path.join(TEST_PARENT, "workspace");

async function createClient(safetyMode = "normal", confirmationMode = "headless"): Promise<Client> {
  const stateDir = path.join(TEST_PARENT, `state-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("build/index.js")],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_SAFETY_MODE: safetyMode,
      MCP_CONFIRMATION_MODE: confirmationMode,
      MCP_ALLOWED_ROOTS: WORKSPACE_ROOT,
      MCP_STATE_DIR: stateDir,
    },
  });
  const client = new Client({ name: "workspace-delete-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function withClient<T>(fn: (client: Client) => Promise<T>, safetyMode = "normal", confirmationMode = "headless") {
  const client = await createClient(safetyMode, confirmationMode);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function structured(result: unknown): Record<string, any> {
  return (result as { structuredContent?: Record<string, any> }).structuredContent ?? {};
}

beforeEach(async () => {
  await fs.rm(TEST_PARENT, { recursive: true, force: true });
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_PARENT, { recursive: true, force: true });
});

describe("workspace-delete headless surface", () => {
  test("previews and deletes a single file with a bound preview", async () => {
    const target = path.join(WORKSPACE_ROOT, "single.txt");
    await fs.writeFile(target, "delete me", "utf8");

    await withClient(async (client) => {
      const preview = await client.callTool({
        name: "delete_preview",
        arguments: { target_path: target, recursive: false },
      });
      expect(preview.isError).toBeFalsy();
      expect(preview._meta?.safety_protocol_version).toBe(2);
      const previewData = structured(preview);
      expect(previewData.type).toBe("file");
      expect(previewData.recursive).toBe(false);
      expect(previewData.snapshot.algorithm).toBe("sha256-lstat-v1");
      expect(previewData.preview_id).toMatch(/^[0-9a-f-]{36}$/);

      const deleted = await client.callTool({
        name: "delete_path",
        arguments: {
          target_path: target,
          recursive: false,
          preview_id: previewData.preview_id,
        },
      });
      expect(deleted.isError).toBeFalsy();
      expect(deleted._meta?.safety_protocol_version).toBe(2);
      expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
    });
  });

  test("previews and deletes a recursive directory", async () => {
    const target = path.join(WORKSPACE_ROOT, "tree");
    await fs.mkdir(path.join(target, "nested"), { recursive: true });
    await fs.writeFile(path.join(target, "nested", "file.txt"), "nested", "utf8");

    await withClient(async (client) => {
      const preview = await client.callTool({
        name: "delete_preview",
        arguments: { target_path: target, recursive: true },
      });
      const previewData = structured(preview);
      expect(preview.isError).toBeFalsy();
      expect(previewData.type).toBe("directory");
      expect(previewData.recursive).toBe(true);
      expect(previewData.file_count).toBe(1);
      expect(previewData.directory_count).toBe(2);

      const deleted = await client.callTool({
        name: "delete_path",
        arguments: { target_path: target, recursive: true, preview_id: previewData.preview_id },
      });
      expect(deleted.isError).toBeFalsy();
      expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
    });
  });

  test("rejects the allowlist root and an outside target", async () => {
    const outside = path.join(TEST_PARENT, "outside.txt");
    await fs.writeFile(outside, "outside", "utf8");

    await withClient(async (client) => {
      const rootPreview = await client.callTool({
        name: "delete_preview",
        arguments: { target_path: WORKSPACE_ROOT, recursive: true },
      });
      expect(rootPreview.isError).toBe(true);
      expect(structured(rootPreview).error.code).toBe("SAFETY_BLOCKED");

      const outsidePreview = await client.callTool({
        name: "delete_preview",
        arguments: { target_path: outside, recursive: false },
      });
      expect(outsidePreview.isError).toBe(true);
      expect(structured(outsidePreview).error.code).toBe("SAFETY_BLOCKED");
      expect(await fs.stat(outside).then(() => true)).toBe(true);
    });
  });

  test("rejects a stale preview without deleting the changed target", async () => {
    const target = path.join(WORKSPACE_ROOT, "stale.txt");
    await fs.writeFile(target, "before", "utf8");

    await withClient(async (client) => {
      const preview = await client.callTool({
        name: "delete_preview",
        arguments: { target_path: target, recursive: false },
      });
      const previewData = structured(preview);
      await fs.writeFile(target, "changed after preview", "utf8");

      const deleted = await client.callTool({
        name: "delete_path",
        arguments: { target_path: target, recursive: false, preview_id: previewData.preview_id },
      });
      expect(deleted.isError).toBe(true);
      expect(structured(deleted).error.code).toBe("VALIDATION_ERROR");
      expect(structured(deleted).error.detail.reason).toBe("preview_stale");
      expect(await fs.readFile(target, "utf8")).toBe("changed after preview");
    });
  });

  test("requires a preview and rejects excluded headless tools", async () => {
    const target = path.join(WORKSPACE_ROOT, "requires-preview.txt");
    await fs.writeFile(target, "keep", "utf8");

    await withClient(async (client) => {
      const noPreview = await client.callTool({
        name: "delete_path",
        arguments: { target_path: target, recursive: false },
      });
      expect(noPreview.isError).toBe(true);
      expect(structured(noPreview).error.code).toBe("VALIDATION_ERROR");

      const write = await client.callTool({
        name: "write_file",
        arguments: { file_path: path.join(WORKSPACE_ROOT, "blocked.txt"), content: "blocked" },
      });
      expect(write.isError).toBe(true);
      expect(structured(write).error.code).toBe("SAFETY_BLOCKED");
      expect(await fs.stat(path.join(WORKSPACE_ROOT, "blocked.txt")).catch(() => undefined)).toBeUndefined();
    });
  });

  test("rejects command, archive, download, and process tools in headless mode", async () => {
    const source = path.join(WORKSPACE_ROOT, "source.txt");
    await fs.writeFile(source, "source", "utf8");

    await withClient(async (client) => {
      const cases = [
        { name: "execute_command", arguments: { command: "echo should-not-run" } },
        {
          name: "copy_move",
          arguments: { source, destination: path.join(WORKSPACE_ROOT, "copy.txt"), operation: "copy" },
        },
        {
          name: "compress_archive",
          arguments: { source_path: source, output_path: path.join(WORKSPACE_ROOT, "archive.zip") },
        },
        {
          name: "extract_archive",
          arguments: {
            archive_path: path.join(WORKSPACE_ROOT, "archive.zip"),
            output_dir: path.join(WORKSPACE_ROOT, "out"),
          },
        },
        {
          name: "download_file",
          arguments: { url: "https://example.com/file.txt", save_path: path.join(WORKSPACE_ROOT, "download.txt") },
        },
        { name: "kill_process", arguments: { name: "notepad.exe" } },
      ];

      for (const item of cases) {
        const result = await client.callTool(item);
        expect(result.isError).toBe(true);
        expect(structured(result).error.code).toBe("SAFETY_BLOCKED");
      }
      expect(await fs.stat(path.join(WORKSPACE_ROOT, "archive.zip")).catch(() => undefined)).toBeUndefined();
      expect(await fs.stat(path.join(WORKSPACE_ROOT, "download.txt")).catch(() => undefined)).toBeUndefined();
    });
  });

  test("reports workspace-delete capability in health resource", async () => {
    await withClient(async (client) => {
      const result = await client.readResource({ uri: "health://status" });
      const text = result.contents[0]?.text;
      expect(typeof text).toBe("string");
      const health = JSON.parse(text as string) as Record<string, any>;
      expect(health.safety_protocol_version).toBe(2);
      expect(health.confirmation_mode).toBe("headless");
      expect(health.headless_surface).toBe("workspace-delete");
      expect(health.allowed_roots).toMatchObject({ configured: true, count: 1 });
    });
  });
});

describe("workspace-delete confirmation compatibility", () => {
  test("normal mode without Elicitation returns ELICITATION_REQUIRED", async () => {
    const target = path.join(WORKSPACE_ROOT, "normal.txt");
    await fs.writeFile(target, "protected", "utf8");

    await withClient(
      async (client) => {
        const result = await client.callTool({
          name: "delete_path",
          arguments: { target_path: target },
        });
        expect(result.isError).toBe(true);
        expect(structured(result).error.code).toBe("ELICITATION_REQUIRED");
        expect(await fs.stat(target).then(() => true)).toBe(true);
      },
      "normal",
      "elicitation",
    );
  });

  test("auto mode without Elicitation returns ELICITATION_REQUIRED", async () => {
    const target = path.join(WORKSPACE_ROOT, "auto.txt");
    await fs.writeFile(target, "protected", "utf8");

    await withClient(
      async (client) => {
        const result = await client.callTool({
          name: "delete_path",
          arguments: { target_path: target },
        });
        expect(result.isError).toBe(true);
        expect(structured(result).error.code).toBe("ELICITATION_REQUIRED");
        expect(await fs.stat(target).then(() => true)).toBe(true);
      },
      "normal",
      "auto",
    );
  });
});

describe("workspace-delete safety-mode surface enforcement", () => {
  test("off mode does not dissolve the headless surface for guarded tools", async () => {
    await withClient(async (client) => {
      const command = await client.callTool({
        name: "execute_command",
        arguments: { command: "echo should-not-run" },
      });
      expect(command.isError).toBe(true);
      expect(structured(command).error.code).toBe("SAFETY_BLOCKED");
      expect(String(structured(command).error.message)).toContain("headless workspace-delete surface");
    }, "off");
  });

  test("off mode headless rejects make_directory even inside allowed roots", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "make_directory",
        arguments: { dir_path: path.join(WORKSPACE_ROOT, "blocked-dir") },
      });
      expect(result.isError).toBe(true);
      expect(structured(result).error.code).toBe("SAFETY_BLOCKED");
      expect(structured(result).error.detail.reason).toBe("headless_surface");
      expect(await fs.stat(path.join(WORKSPACE_ROOT, "blocked-dir")).catch(() => undefined)).toBeUndefined();
    }, "off");
  });

  test("off mode headless still deletes with a bound preview inside allowed roots", async () => {
    const target = path.join(WORKSPACE_ROOT, "off-delete.txt");
    await fs.writeFile(target, "delete me", "utf8");

    await withClient(async (client) => {
      const preview = await client.callTool({
        name: "delete_preview",
        arguments: { target_path: target, recursive: false },
      });
      const previewData = structured(preview);
      const deleted = await client.callTool({
        name: "delete_path",
        arguments: { target_path: target, recursive: false, preview_id: previewData.preview_id },
      });
      expect(deleted.isError).toBeFalsy();
      expect(await fs.stat(target).catch(() => undefined)).toBeUndefined();
    }, "off");
  });

  test("strict mode still blocks delete_path in headless configuration", async () => {
    const target = path.join(WORKSPACE_ROOT, "strict.txt");
    await fs.writeFile(target, "keep", "utf8");

    await withClient(async (client) => {
      const result = await client.callTool({
        name: "delete_path",
        arguments: { target_path: target, recursive: false },
      });
      expect(result.isError).toBe(true);
      expect(structured(result).error.code).toBe("SAFETY_BLOCKED");
      expect(structured(result).error.detail.reason).toBe("strict");
      expect(await fs.stat(target).then(() => true)).toBe(true);
    }, "strict");
  });

  test("pure off without headless keeps legacy behavior for commands", async () => {
    await withClient(
      async (client) => {
        const result = await client.callTool({
          name: "execute_command",
          arguments: { command: "echo compat-ok" },
        });
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result)).toContain("compat-ok");
      },
      "off",
      "elicitation",
    );
  });
});
