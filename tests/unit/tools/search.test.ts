/**
 * search.ts 可测试逻辑单元测试
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ES_EXE_ENV, resetEsIntegrityCache, resolveEsExe } from "../../../src/es-integrity.js";
import { execFileManaged, ManagedProcessError } from "../../../src/process-supervisor.js";
import { getShellSpec } from "../../../src/shell.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { globToRegex, registerSearchTools } from "../../../src/tools/search.js";

// 默认透传真实实现；单用例内用 mockResolvedValueOnce/mockRejectedValueOnce 注入受控结果，
// once 队列消费完即回落真实实现，不串扰同文件其他用例（如真 PS grep 用例）。
vi.mock("../../../src/process-supervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/process-supervisor.js")>();
  return { ...actual, execFileManaged: vi.fn(actual.execFileManaged) };
});

vi.mock("../../../src/es-integrity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/es-integrity.js")>();
  return { ...actual, resolveEsExe: vi.fn(actual.resolveEsExe) };
});

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

  test("search_files rejects max_results outside the allowed range", async () => {
    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*.txt",
      max_results: 0,
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "max_results" });
  });

  test("search_files rejects an overlong pattern", async () => {
    const result = await registerTools()
      .get("search_files")
      ?.handler({
        dir_path: searchDir,
        pattern: "a".repeat(513),
      });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "pattern" });
  });

  test("grep_content rejects an overlong file_pattern", async () => {
    const result = await registerTools()
      .get("grep_content")
      ?.handler({
        dir_path: searchDir,
        pattern: "needle",
        file_pattern: "a".repeat(300),
      });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR", param: "file_pattern" });
  });

  test.skipIf(process.platform !== "win32")("everything_search maps CLI timeout to TIMEOUT", async () => {
    vi.mocked(resolveEsExe).mockResolvedValueOnce({ available: true, source: "state", path: "D:\\fake\\es.exe" });
    vi.mocked(execFileManaged).mockRejectedValueOnce(
      new ManagedProcessError("timed out after 15000ms", {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        cancelled: false,
        terminationFailed: false,
      }),
    );

    const result = await registerTools().get("everything_search")?.handler({ query: "*.txt" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  test.skipIf(process.platform !== "win32")("everything_search maps maxBuffer overflow to RESOURCE_LIMIT", async () => {
    vi.mocked(resolveEsExe).mockResolvedValueOnce({ available: true, source: "state", path: "D:\\fake\\es.exe" });
    vi.mocked(execFileManaged).mockRejectedValueOnce(
      new ManagedProcessError("stdout maxBuffer length exceeded", {
        stdout: "",
        stderr: "",
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationFailed: false,
      }),
    );

    const result = await registerTools().get("everything_search")?.handler({ query: "*.txt" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  test.skipIf(process.platform !== "win32")(
    "everything_search maps non-zero exit to EXECUTION_FAILED with bounded detail",
    async () => {
      vi.mocked(resolveEsExe).mockResolvedValueOnce({ available: true, source: "state", path: "D:\\fake\\es.exe" });
      vi.mocked(execFileManaged).mockRejectedValueOnce(
        new ManagedProcessError("Command failed: es.exe", {
          stdout: "",
          stderr: "",
          exitCode: 1,
          signal: null,
          timedOut: false,
          cancelled: false,
          terminationFailed: false,
        }),
      );

      const result = await registerTools().get("everything_search")?.handler({ query: "*.txt" });

      expect(result?.isError).toBe(true);
      expect(result?.structuredContent.error).toMatchObject({
        code: "EXECUTION_FAILED",
        detail: { exitCode: 1, signal: null },
      });
    },
  );

  test.skipIf(process.platform !== "win32")(
    "everything_search returns an empty complete result set on zero matches",
    async () => {
      vi.mocked(resolveEsExe).mockResolvedValueOnce({ available: true, source: "state", path: "D:\\fake\\es.exe" });
      vi.mocked(execFileManaged).mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationFailed: false,
      });

      const result = await registerTools().get("everything_search")?.handler({ query: "*.txt" });

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent).toMatchObject({
        matches: [],
        total: 0,
        truncated: false,
        complete: true,
        warnings: [],
      });
    },
  );

  test.skipIf(process.platform !== "win32")(
    "search_files warns and falls back to native when the Everything CLI fails",
    async () => {
      await fs.writeFile(path.join(searchDir, "fallback-hit.txt"), "x", "utf-8");
      vi.mocked(resolveEsExe).mockResolvedValueOnce({ available: true, source: "state", path: "D:\\fake\\es.exe" });
      vi.mocked(execFileManaged).mockRejectedValueOnce(new Error("spawn es.exe ENOENT"));

      const result = await registerTools().get("search_files")?.handler({
        dir_path: searchDir,
        pattern: "*.txt",
        max_depth: 1,
      });

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent.warnings[0].code).toBe("EVERYTHING_EXEC_FAILED");
      expect(result?.structuredContent.complete).toBe(true);
      expect(result?.structuredContent.matches).toContain(path.join(searchDir, "fallback-hit.txt"));
    },
  );

  test.skipIf(process.platform !== "win32")("grep_content surfaces PS partial walk errors via warnings", async () => {
    const shellSpec = await getShellSpec().catch(() => null);
    // 环境解析不到 PowerShell flavor 时该路径本就不会启用，软跳过避免环境耦合
    if (!shellSpec || (shellSpec.flavor !== "pwsh" && shellSpec.flavor !== "powershell")) return;
    vi.mocked(execFileManaged).mockResolvedValueOnce({
      stdout: "",
      stderr: "ETMCP_PARTIAL_ERRORS=3",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      terminationFailed: false,
    });

    const result = await registerTools().get("grep_content")?.handler({
      dir_path: searchDir,
      pattern: "needle",
      max_results: 5,
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.complete).toBe(false);
    expect(result?.structuredContent.warnings).toEqual([{ code: "PS_PARTIAL_WALK_ERRORS", count: 3 }]);
  });
});
