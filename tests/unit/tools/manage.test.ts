/**
 * manage.ts 工具行为单元测试（fake server 直调 handler）
 *
 * delete_path / copy_move 的成功路径、错误映射与敏感路径底线。
 * 破坏性确认交互在 MCP_SAFETY_MODE=off 下跳过（normal 模式由 e2e 覆盖）；
 * validatePath 的敏感路径拒绝与模式无关，优先断言。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { initSafeGuard } from "../../../src/safeguard.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { registerManageTools } from "../../../src/tools/manage.js";

const TMP_BASE = fileURLToPath(new URL("../../../.etmcp/test-tmp/", import.meta.url));
const ENV_KEYS = ["MCP_SAFETY_MODE", "MCP_STATE_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

type ToolHandler = (args: Record<string, unknown>) => Promise<any>;

function registerTools() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _spec: unknown, handler: ToolHandler) {
      tools.set(name, { handler });
    },
  };
  registerManageTools(server as any);
  return tools;
}

async function call(tools: Map<string, ToolHandler>, name: string, args: Record<string, unknown>) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`Missing tool: ${name}`);
  return entry.handler(args);
}

describe("manage tools (unit)", () => {
  let workDir: string;
  let tools: Map<string, ToolHandler>;

  beforeEach(async () => {
    await fs.mkdir(TMP_BASE, { recursive: true });
    workDir = await fs.mkdtemp(path.join(TMP_BASE, "manage-"));
    process.env.MCP_SAFETY_MODE = "off";
    process.env.MCP_STATE_DIR = path.join(workDir, "state");
    resetStateDirCache();
    initSafeGuard();
    tools = registerTools();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStateDirCache();
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("copy_move copies files recursively", async () => {
    const source = path.join(workDir, "src.txt");
    const destination = path.join(workDir, "nested", "dst.txt");
    await fs.writeFile(source, "payload", "utf-8");

    const result = await call(tools, "copy_move", { source, destination, operation: "copy" });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ operation: "copy" });
    expect(await fs.readFile(destination, "utf-8")).toBe("payload");
    await expect(fs.access(source)).resolves.toBeUndefined();
  });

  test("copy_move moves files and removes the source", async () => {
    const source = path.join(workDir, "src.txt");
    const destination = path.join(workDir, "dst.txt");
    await fs.writeFile(source, "payload", "utf-8");

    const result = await call(tools, "copy_move", { source, destination, operation: "move" });

    expect(result?.isError).toBeFalsy();
    await expect(fs.access(source)).rejects.toThrow();
    await expect(fs.readFile(destination, "utf-8")).resolves.toBe("payload");
  });

  test("delete_path removes a single file", async () => {
    const file = path.join(workDir, "gone.txt");
    await fs.writeFile(file, "x", "utf-8");

    const result = await call(tools, "delete_path", { target_path: file });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ path: file, type: "file" });
    await expect(fs.access(file)).rejects.toThrow();
  });

  test("delete_path refuses directories without recursive=true", async () => {
    const dir = path.join(workDir, "dir");
    await fs.mkdir(dir);

    const result = await call(tools, "delete_path", { target_path: dir });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "recursive" });
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  test("delete_path removes directories with recursive=true", async () => {
    const dir = path.join(workDir, "tree");
    await fs.mkdir(path.join(dir, "inner"), { recursive: true });

    const result = await call(tools, "delete_path", { target_path: dir, recursive: true });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ type: "dir" });
    await expect(fs.access(dir)).rejects.toThrow();
  });

  test("delete_path enforces the sensitive-path floor regardless of safety mode", async () => {
    const pem = path.join(workDir, "cert.pem");
    await fs.writeFile(pem, "key", "utf-8");

    const result = await call(tools, "delete_path", { target_path: pem });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PATH_FORBIDDEN", param: "target_path" });
    await expect(fs.access(pem)).resolves.toBeUndefined();
  });

  test("delete_path maps missing targets to PATH_NOT_FOUND", async () => {
    const result = await call(tools, "delete_path", { target_path: path.join(workDir, "nope.txt") });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PATH_NOT_FOUND" });
  });
});
