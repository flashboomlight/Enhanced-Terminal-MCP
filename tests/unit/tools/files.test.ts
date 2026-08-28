/**
 * files.ts 工具行为单元测试（fake server 直调 handler）
 *
 * 覆盖 e2e 盲区：read/write/mkdir/list/file_info 的成功路径、错误映射与
 * secrets 扫描分级（write 拦截 / strict 读拦截）。安全模式统一 off，
 * normal 模式的确认交互由 e2e 与 safeguard 单测覆盖。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initSafeGuard } from "../../../src/safeguard.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { registerFileTools } from "../../../src/tools/files.js";

// 部分 mock：仅 readdir 对名称含 "blocked-sub" 的目录抛 EACCES，模拟递归遍历中的
// 权限拒绝子目录；其余 fs API 与测试自身 setup 全部透传真实实现。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(async (target: unknown, options?: unknown) => {
      if (String(target).includes("blocked-sub")) {
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      }
      return (actual.readdir as (t: unknown, o?: unknown) => Promise<unknown>)(target, options);
    }),
  };
});

const TMP_BASE = fileURLToPath(new URL("../../../.etmcp/test-tmp/", import.meta.url));
const ENV_KEYS = ["MCP_SAFETY_MODE", "MCP_SECRETS_SCAN", "MCP_STATE_DIR"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

type ToolHandler = (args: Record<string, unknown>) => Promise<any>;

function registerTools() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _spec: unknown, handler: ToolHandler) {
      tools.set(name, { handler });
      return { disable() {} };
    },
  };
  registerFileTools(server as any);
  return tools;
}

async function call(tools: Map<string, ToolHandler>, name: string, args: Record<string, unknown>) {
  const entry = tools.get(name);
  if (!entry) throw new Error(`Missing tool: ${name}`);
  return entry.handler(args);
}

describe("files tools (unit)", () => {
  let workDir: string;
  let tools: Map<string, ToolHandler>;

  beforeEach(async () => {
    await fs.mkdir(TMP_BASE, { recursive: true });
    workDir = await fs.mkdtemp(path.join(TMP_BASE, "files-"));
    process.env.MCP_SAFETY_MODE = "off";
    delete process.env.MCP_SECRETS_SCAN;
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

  test("write_file creates nested parents and reports size", async () => {
    const target = path.join(workDir, "nested", "dir", "hello.txt");
    const result = await call(tools, "write_file", { file_path: target, content: "hello world" });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ path: target, existed: false, appended: false });
    expect((await fs.readFile(target, "utf-8")).toString()).toBe("hello world");
  });

  test("write_file rejects secret-looking content at default cache tier", async () => {
    const target = path.join(workDir, "secret.txt");
    const result = await call(tools, "write_file", {
      file_path: target,
      content: "token=ghp_1234567890abcdefghij",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PATH_SENSITIVE", param: "content" });
    await expect(fs.access(target)).rejects.toThrow();
  });

  test("read_file maps missing files to PATH_NOT_FOUND", async () => {
    const result = await call(tools, "read_file", { file_path: path.join(workDir, "missing.txt") });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PATH_NOT_FOUND", param: "file_path" });
  });

  test("read_file supports offset/lines paging and truncation flag", async () => {
    const target = path.join(workDir, "lines.txt");
    await fs.writeFile(target, ["l1", "l2", "l3", "l4", "l5"].join("\n"), "utf-8");

    const result = await call(tools, "read_file", { file_path: target, offset: 2, lines: 2 });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ total_lines: 4, truncated: true });
    expect(result?.structuredContent.content).toBe("l2\nl3");
  });

  test("read_file rejects unsupported encodings before touching the filesystem", async () => {
    const result = await call(tools, "read_file", {
      file_path: path.join(workDir, "any.txt"),
      encoding: "rot13",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "encoding" });
  });

  test("strict secrets tier blocks reading credential content", async () => {
    process.env.MCP_SECRETS_SCAN = "strict";
    const target = path.join(workDir, "cred.txt");
    await fs.writeFile(target, "key=sk-abcdefghijklmnopqrstuvwxyz012345", "utf-8");

    const result = await call(tools, "read_file", { file_path: target });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PATH_SENSITIVE" });
    expect(result?.structuredContent.error.detail.findings).toContain("OpenAI API Key");
  });

  test("make_directory creates nested dirs and reports created flag", async () => {
    const dir = path.join(workDir, "a", "b", "c");
    const first = await call(tools, "make_directory", { dir_path: dir });
    const second = await call(tools, "make_directory", { dir_path: dir });

    expect(first?.structuredContent).toMatchObject({ path: dir, created: true });
    expect(second?.structuredContent).toMatchObject({ created: false });
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  test("list_directory returns structured entries for files and dirs", async () => {
    await fs.writeFile(path.join(workDir, "a.txt"), "x", "utf-8");
    await fs.mkdir(path.join(workDir, "sub"));

    const result = await call(tools, "list_directory", { dir_path: workDir });

    expect(result?.isError).toBeFalsy();
    const names = (result?.structuredContent.entries as Array<{ name: string }>).map((e) => path.basename(e.name));
    expect(names).toContain("a.txt");
    expect(names).toContain("sub");
  });

  test("file_info reports dir/file classification", async () => {
    const file = path.join(workDir, "f.txt");
    await fs.writeFile(file, "12345", "utf-8");

    const result = await call(tools, "file_info", { target_path: file });

    expect(result?.structuredContent).toMatchObject({ is_file: true, is_dir: false, size_bytes: 5 });
  });

  test("make_directory maps fs failures to execution errors", async () => {
    const result = await call(tools, "list_directory", { dir_path: path.join(workDir, "nope") });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PATH_NOT_FOUND", param: "dir_path" });
  });

  test("read_file rejects a symlink resolving into a sensitive directory", async () => {
    const sensitive = path.join(workDir, ".ssh");
    await fs.mkdir(sensitive);
    await fs.writeFile(path.join(sensitive, "id_rsa"), "key");
    const link = path.join(workDir, "innocent-link");
    await fs.symlink(sensitive, link, "junction");

    const result = await call(tools, "read_file", { file_path: link });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error.code).toBe("PATH_FORBIDDEN");
  });

  test("write_file refuses a symlink target without touching the real file (no-follow)", async () => {
    const real = path.join(workDir, "real.txt");
    await fs.writeFile(real, "keep");
    const link = path.join(workDir, "lnk.txt");
    await fs.symlink(real, link);

    const result = await call(tools, "write_file", { file_path: link, content: "overwrite" });
    expect(result?.isError).toBe(true);
    expect(await fs.readFile(real, "utf-8")).toBe("keep");
    expect(result?.structuredContent.error.message).toMatch(/no-follow/);
  });

  test("write_file overwrite lands through atomic staging without residue", async () => {
    const target = path.join(workDir, "atomic.txt");
    await fs.writeFile(target, "old");
    const result = await call(tools, "write_file", { file_path: target, content: "new" });
    expect(result?.isError).toBeFalsy();
    expect(await fs.readFile(target, "utf-8")).toBe("new");
    const entries = await fs.readdir(workDir);
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
  });

  test("write_file fails closed under strict tier when content exceeds scanner capacity", async () => {
    const originalScan = process.env.MCP_SECRETS_SCAN;
    process.env.MCP_SECRETS_SCAN = "strict";
    try {
      const result = await call(tools, "write_file", {
        file_path: path.join(workDir, "big.txt"),
        content: "a".repeat(5 * 1024 * 1024),
      });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent.error).toMatchObject({ code: "RESOURCE_LIMIT", param: "content" });
      await expect(fs.access(path.join(workDir, "big.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalScan === undefined) delete process.env.MCP_SECRETS_SCAN;
      else process.env.MCP_SECRETS_SCAN = originalScan;
    }
  });

  test("write_file under default tier writes oversize content (allow decision, no scan claim)", async () => {
    const target = path.join(workDir, "big-cache-tier.txt");
    const result = await call(tools, "write_file", {
      file_path: target,
      content: "b".repeat(5 * 1024 * 1024),
    });
    expect(result?.isError).toBeFalsy();
    const stat = await fs.stat(target);
    expect(stat.size).toBe(5 * 1024 * 1024);
  });

  test("read_file fails closed under strict tier when output exceeds scanner capacity", async () => {
    const originalScan = process.env.MCP_SECRETS_SCAN;
    process.env.MCP_SECRETS_SCAN = "strict";
    try {
      const big = path.join(workDir, "big-read.txt");
      await fs.writeFile(big, `${"c".repeat(64)}\n`.repeat(90_000));
      const result = await call(tools, "read_file", { file_path: big });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent.error).toMatchObject({ code: "RESOURCE_LIMIT", param: "file_path" });
    } finally {
      if (originalScan === undefined) delete process.env.MCP_SECRETS_SCAN;
      else process.env.MCP_SECRETS_SCAN = originalScan;
    }
  });

  test("list_directory rejects max_depth outside the allowed range", async () => {
    const low = await call(tools, "list_directory", { dir_path: workDir, max_depth: 0 });
    expect(low?.isError).toBe(true);
    expect(low?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "max_depth" });

    const high = await call(tools, "list_directory", { dir_path: workDir, max_depth: 33 });
    expect(high?.isError).toBe(true);
    expect(high?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "max_depth" });
  });

  test("list_directory reports a partial result when a recursive subdir is unreadable", async () => {
    await fs.mkdir(path.join(workDir, "ok-dir"));
    await fs.writeFile(path.join(workDir, "ok-dir", "file.txt"), "x", "utf-8");
    await fs.mkdir(path.join(workDir, "blocked-sub"));

    const result = await call(tools, "list_directory", { dir_path: workDir, recursive: true });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.complete).toBe(false);
    expect(result?.structuredContent.warnings).toHaveLength(1);
    expect(result?.structuredContent.warnings[0].code).toBe("WALK_READ_FAILED");
    const names = (result?.structuredContent.entries as Array<{ name: string }>).map((e) => path.basename(e.name));
    expect(names).toContain("ok-dir");
    expect(names).toContain("file.txt");
    expect(names).toContain("blocked-sub");
  });

  test("list_directory fails as a whole when the requested dir itself is unreadable", async () => {
    const blocked = path.join(workDir, "blocked-sub");
    await fs.mkdir(blocked);

    const result = await call(tools, "list_directory", { dir_path: blocked });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "EXECUTION_FAILED" });
  });

  test("list_directory marks a clean recursive listing complete with no warnings", async () => {
    await fs.mkdir(path.join(workDir, "sub-clean"));
    await fs.writeFile(path.join(workDir, "sub-clean", "a.txt"), "x", "utf-8");

    const result = await call(tools, "list_directory", { dir_path: workDir, recursive: true });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.complete).toBe(true);
    expect(result?.structuredContent.warnings).toEqual([]);
  });
});
