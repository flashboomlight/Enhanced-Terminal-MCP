/**
 * search.ts 可测试逻辑单元测试
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ES_EXE_ENV, resetEsIntegrityCache } from "../../../src/es-integrity.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { globToRegex, registerSearchTools } from "../../../src/tools/search.js";

const ENV_KEYS = ["MCP_STATE_DIR", ES_EXE_ENV] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const TMP_DIR = fileURLToPath(new URL("../../../.etmcp/test-tmp/", import.meta.url));

function registerTools() {
  const tools = new Map<string, { handler: (args: Record<string, unknown>) => Promise<any> }>();
  const server = {
    registerTool(name: string, _spec: unknown, handler: (args: Record<string, unknown>) => Promise<any>) {
      tools.set(name, { handler });
    },
  };
  registerSearchTools(server as any);
  return tools;
}

describe("search tools pure logic", () => {
  let stateDir: string;
  let searchDir: string;

  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    stateDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-search-state-"));
    searchDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-search-files-"));
    process.env.MCP_STATE_DIR = stateDir;
    delete process.env[ES_EXE_ENV];
    resetStateDirCache();
    resetEsIntegrityCache();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStateDirCache();
    resetEsIntegrityCache();
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(searchDir, { recursive: true, force: true });
  });

  test("globToRegex matches wildcard patterns", () => {
    const re = globToRegex("*.ts");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("file.js")).toBe(false);
  });

  test("globToRegex matches single char wildcard", () => {
    const re = globToRegex("test?.txt");
    expect(re.test("test1.txt")).toBe(true);
    expect(re.test("test12.txt")).toBe(false);
  });

  test("globToRegex escapes regex metacharacters", () => {
    const re = globToRegex("file[1].txt");
    expect(re.test("file[1].txt")).toBe(true);
    expect(re.test("file1.txt")).toBe(false);
  });

  test("grep_content returns multiple matching lines up to max_results", async () => {
    const tmpDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-grep-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "matches.txt"), "needle one\nskip\nneedle two\nneedle three\n", "utf-8");
      const tools = registerTools();

      const result = await tools.get("grep_content")?.handler({
        dir_path: tmpDir,
        pattern: "needle",
        file_pattern: "*.txt",
        max_results: 2,
      });

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent.matches).toHaveLength(2);
      expect(result?.structuredContent.matches[0]).toContain("needle one");
      expect(result?.structuredContent.matches[1]).toContain("needle two");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "win32")(
    "uses native fallback when the implicit state binary is unavailable",
    async () => {
      await fs.writeFile(path.join(searchDir, "native-match.txt"), "match", "utf-8");
      const result = await registerTools().get("search_files")?.handler({
        dir_path: searchDir,
        pattern: "*.txt",
        max_depth: 1,
      });

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent.matches).toContain(path.join(searchDir, "native-match.txt"));
    },
  );

  test.skipIf(process.platform !== "win32")("fails closed for an invalid explicit binary path", async () => {
    await fs.writeFile(path.join(searchDir, "native-match.txt"), "match", "utf-8");
    process.env[ES_EXE_ENV] = path.join(stateDir, "missing", "es.exe");
    resetEsIntegrityCache();

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*.txt",
      max_depth: 1,
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({
      code: "VALIDATION_ERROR",
      param: ES_EXE_ENV,
      detail: {
        reason: "explicit_path_missing",
        env_name: ES_EXE_ENV,
        download_performed: false,
      },
    });
  });

  test.skipIf(process.platform !== "win32")("returns installation detail when Everything is unavailable", async () => {
    const result = await registerTools().get("everything_search")?.handler({ query: "*.txt" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({
      code: "EXECUTION_FAILED",
      detail: {
        reason: "state_path_missing",
        expected_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        env_name: ES_EXE_ENV,
        default_path: path.join(stateDir, "tools", "es.exe"),
        download_performed: false,
      },
    });
  });

  test.skipIf(process.platform !== "win32")(
    "keeps explicit Everything configuration failures in the execution contract",
    async () => {
      process.env[ES_EXE_ENV] = path.join(stateDir, "missing", "es.exe");
      resetEsIntegrityCache();

      const result = await registerTools().get("everything_search")?.handler({ query: "*.txt" });

      expect(result?.isError).toBe(true);
      expect(result?.structuredContent.error).toMatchObject({
        code: "EXECUTION_FAILED",
        param: ES_EXE_ENV,
        detail: {
          reason: "explicit_path_missing",
          env_name: ES_EXE_ENV,
          download_performed: false,
        },
      });
    },
  );
});
