/**
 * apply-mcp-sdk-patch.mjs 行为回归
 *
 * postinstall 补丁脚本的失败语义必须可测：patched / already 幂等、
 * SDK 布局变化和模式失配均 fail-closed（退出码 1），未安装时跳过。
 * 通过复制脚本到 fixture 根目录执行，隔离真实 node_modules。
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TMP_BASE = path.join(PROJECT_ROOT, ".etmcp", "test-tmp");
const SCRIPT_REL = path.join("scripts", "apply-mcp-sdk-patch.mjs");
const MCP_JS_REL = path.join("node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "mcp.js");

const OLD_SDK_SHAPE = `const EMPTY_OBJECT_JSON_SCHEMA = {
    type: 'object',
    properties: {}
};
function internal(obj) {
    return obj ? (0, zod_json_schema_compat_js_1.toJsonSchemaCompat)(obj, { target: "draft-7" }) : EMPTY_OBJECT_JSON_SCHEMA;
}
`;

let fixturesRoot: string | null = null;

beforeAll(async () => {
  await mkdir(TMP_BASE, { recursive: true });
  fixturesRoot = await mkdtemp(path.join(TMP_BASE, "sdk-patch-"));
});

afterEach(async () => {
  if (!fixturesRoot) return;
  await rm(fixturesRoot, { recursive: true, force: true });
  fixturesRoot = null;
});

/** 在隔离安装根下复制补丁脚本并注入 fixture 文件 */
async function makeFixture(name: string, files: Record<string, string>): Promise<string> {
  if (!fixturesRoot) {
    await mkdir(TMP_BASE, { recursive: true });
    fixturesRoot = await mkdtemp(path.join(TMP_BASE, "sdk-patch-"));
  }
  const root = path.join(fixturesRoot, name);
  await mkdir(root, { recursive: true });
  await cp(path.join(PROJECT_ROOT, SCRIPT_REL), path.join(root, SCRIPT_REL), { force: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

/** 在隔离环境中执行补丁脚本，返回退出码与输出 */
async function runPatch(root: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.INIT_CWD;
  delete env.npm_config_local_prefix;
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [path.join(root, SCRIPT_REL)], { env, cwd: root }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe("apply-mcp-sdk-patch", () => {
  test("patches a fresh SDK layout and is idempotent on re-run", async () => {
    const root = await makeFixture(`fresh-${Date.now()}`, {
      [path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json")]:
        '{"name":"@modelcontextprotocol/sdk"}',
      [MCP_JS_REL]: OLD_SDK_SHAPE,
    });

    const first = await runPatch(root);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("patched");
    const patched = await readFile(path.join(root, MCP_JS_REL), "utf8");
    expect(patched).toContain("required: []");

    const second = await runPatch(root);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("already applied");
  });

  test("fails closed when SDK is installed but dist layout is gone", async () => {
    const root = await makeFixture(`layout-gone-${Date.now()}`, {
      [path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json")]:
        '{"name":"@modelcontextprotocol/sdk"}',
    });

    const result = await runPatch(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ERROR");
    expect(result.stderr).toContain("layout");
  });

  test("skips quietly when the SDK is not installed at all", async () => {
    const root = await makeFixture(`no-sdk-${Date.now()}`, {});

    const result = await runPatch(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("not found");
  });

  test("fails closed when file exists but patterns no longer match", async () => {
    const root = await makeFixture(`mismatch-${Date.now()}`, {
      [path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json")]:
        '{"name":"@modelcontextprotocol/sdk"}',
      [MCP_JS_REL]: "// upstream rewrote this file completely\nexport const x = 1;\n",
    });

    const result = await runPatch(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ERROR");
  });

  test("does not patch an unrelated SDK under the consumer root", async () => {
    const root = await makeFixture(`owned-${Date.now()}`, {
      [path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json")]:
        '{"name":"@modelcontextprotocol/sdk"}',
      [MCP_JS_REL]: OLD_SDK_SHAPE,
      [path.join("consumer", "node_modules", "@modelcontextprotocol", "sdk", "package.json")]:
        '{"name":"@modelcontextprotocol/sdk","version":"1.29.0"}',
      [path.join("consumer", MCP_JS_REL)]: OLD_SDK_SHAPE,
    });

    const result = await runPatch(root);
    expect(result.code).toBe(0);
    const unrelated = await readFile(path.join(root, "consumer", MCP_JS_REL), "utf8");
    expect(unrelated).toBe(OLD_SDK_SHAPE);
  });

  test("fails closed when the package-owned SDK version is unsupported", async () => {
    const root = await makeFixture(`version-${Date.now()}`, {
      [path.join("node_modules", "@modelcontextprotocol", "sdk", "package.json")]:
        '{"name":"@modelcontextprotocol/sdk","version":"1.30.0"}',
      [MCP_JS_REL]: OLD_SDK_SHAPE,
    });

    const result = await runPatch(root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unsupported");
    const unchanged = await readFile(path.join(root, MCP_JS_REL), "utf8");
    expect(unchanged).toBe(OLD_SDK_SHAPE);
  });
});
