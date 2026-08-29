/**
 * search_files 的 fd 引擎路径单元测试（非 Windows 可选加速）
 *
 * platform.js 被 mock 为 IS_WIN=false：fd 分支在 Windows CI 上同样执行，
 * 保证 tools 层覆盖率 floor 不失守（design 2026-08-29-linux-fd-search §8）。
 * execFileManaged / resolveFd 默认透传真实实现，单用例内用 once 队列注入受控结果。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FD_PATH_ENV, resetFdResolverCache, resolveFd } from "../../../src/fd-resolver.js";
import { WARNING_CODES } from "../../../src/partial-result.js";
import { execFileManaged, ManagedProcessError } from "../../../src/process-supervisor.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { buildFdArgs, registerSearchTools } from "../../../src/tools/search.js";

vi.mock("../../../src/platform.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/platform.js")>();
  return { ...actual, IS_WIN: false };
});

vi.mock("../../../src/process-supervisor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/process-supervisor.js")>();
  return { ...actual, execFileManaged: vi.fn(actual.execFileManaged) };
});

vi.mock("../../../src/fd-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/fd-resolver.js")>();
  return { ...actual, resolveFd: vi.fn(actual.resolveFd) };
});

const ENV_KEYS = ["MCP_STATE_DIR", FD_PATH_ENV] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const TMP_DIR = fileURLToPath(new URL("../../../.etmcp/test-tmp/", import.meta.url));

interface CapturedExec {
  file: string;
  args: string[];
  params: Record<string, unknown>;
}

function registerTools() {
  const tools = new Map<
    string,
    { handler: (args: Record<string, unknown>, extra?: { requestId: string; signal: AbortSignal }) => Promise<any> }
  >();
  const server = {
    registerTool(
      name: string,
      _spec: unknown,
      handler: (args: Record<string, unknown>, extra?: { requestId: string; signal: AbortSignal }) => Promise<any>,
    ) {
      tools.set(name, { handler });
    },
  };
  registerSearchTools(server as any);
  return tools;
}

/** 队列一个 fd 可用的解析结果（deterministic，不依赖宿主是否安装 fd） */
function queueFdAvailable(fdPath = "/usr/bin/fd") {
  vi.mocked(resolveFd).mockResolvedValueOnce({ available: true, source: "path", path: fdPath, version: "fd 10.4.2" });
}

describe("buildFdArgs 纯逻辑", () => {
  test("默认不含 --max-depth，pattern/dir 位于 -- 之后", () => {
    expect(buildFdArgs("*.ts", "/data/dir", 50)).toEqual([
      "--color=never",
      "--absolute-path",
      "--glob",
      "--ignore-case",
      "--no-ignore",
      "--max-results",
      "50",
      "--",
      "*.ts",
      "/data/dir",
    ]);
  });

  test("显式 maxDepth 才下发 --max-depth", () => {
    expect(buildFdArgs("*.ts", "/data/dir", 50, 3)).toEqual([
      "--color=never",
      "--absolute-path",
      "--glob",
      "--ignore-case",
      "--no-ignore",
      "--max-results",
      "50",
      "--max-depth",
      "3",
      "--",
      "*.ts",
      "/data/dir",
    ]);
  });
});

describe("search_files fd 引擎路径", () => {
  let stateDir: string;
  let searchDir: string;

  beforeEach(async () => {
    await fs.mkdir(TMP_DIR, { recursive: true });
    stateDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-fd-state-"));
    searchDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-fd-files-"));
    await fs.writeFile(path.join(searchDir, "alpha-report.txt"), "x", "utf-8");
    await fs.mkdir(path.join(searchDir, "inner"));
    await fs.writeFile(path.join(searchDir, "inner", "gamma.txt"), "x", "utf-8");
    process.env.MCP_STATE_DIR = stateDir;
    delete process.env[FD_PATH_ENV];
    resetStateDirCache();
    resetFdResolverCache();
    vi.mocked(execFileManaged).mockClear();
    vi.mocked(resolveFd).mockClear();
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStateDirCache();
    resetFdResolverCache();
    await fs.rm(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await fs.rm(searchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  test("fd 命中：exec 参数逐字段断言，stdout 行解析为 matches", async () => {
    queueFdAvailable();
    let captured: CapturedExec | null = null;
    vi.mocked(execFileManaged).mockImplementationOnce(async (file, args, params) => {
      captured = { file, args: [...args], params: params as Record<string, unknown> };
      return {
        stdout: `${path.join(searchDir, "alpha-report.txt")}\n`,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationFailed: false,
      };
    });

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*report*",
      max_results: 10,
    });

    expect(result?.isError).toBeFalsy();
    expect(captured?.file).toBe("/usr/bin/fd");
    expect(captured?.args).toEqual([
      "--color=never",
      "--absolute-path",
      "--glob",
      "--ignore-case",
      "--no-ignore",
      "--max-results",
      "10",
      "--",
      "*report*",
      searchDir,
    ]);
    expect(captured?.params).toMatchObject({ maxBuffer: 10 * 1024 * 1024, timeoutMs: 10000, kind: "fd-search" });
    expect(result?.structuredContent).toMatchObject({
      matches: [path.join(searchDir, "alpha-report.txt")],
      total: 1,
      truncated: false,
      complete: true,
      warnings: [],
    });
  });

  test("显式 max_depth 时 --max-depth 随 fd 参数下发", async () => {
    queueFdAvailable();
    let captured: CapturedExec | null = null;
    vi.mocked(execFileManaged).mockImplementationOnce(async (file, args, params) => {
      captured = { file, args: [...args], params: params as Record<string, unknown> };
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationFailed: false,
      };
    });

    await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*.txt",
      max_depth: 2,
      max_results: 5,
    });

    expect(captured?.args).toContain("--max-depth");
    expect(captured?.args).toEqual(expect.arrayContaining(["--max-results", "5", "--max-depth", "2"]));
  });

  test("fd stderr 非空行 → complete=false + FD_PARTIAL_ERRORS 计数", async () => {
    queueFdAvailable();
    vi.mocked(execFileManaged).mockResolvedValueOnce({
      stdout: `${path.join(searchDir, "alpha-report.txt")}\n`,
      stderr: "permission denied: /root/x\npermission denied: /root/y\n",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      terminationFailed: false,
    });

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*report*",
      max_results: 10,
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.complete).toBe(false);
    expect(result?.structuredContent.warnings).toEqual([{ code: WARNING_CODES.FD_PARTIAL_ERRORS, count: 2 }]);
    expect(result?.structuredContent.matches).toHaveLength(1);
  });

  test("fd 执行失败 → FD_EXEC_FAILED warning 后原生兜底命中 fixture", async () => {
    queueFdAvailable();
    vi.mocked(execFileManaged).mockRejectedValueOnce(new Error("spawn fd ENOENT"));

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*gamma*",
      max_results: 10,
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.warnings[0].code).toBe(WARNING_CODES.FD_EXEC_FAILED);
    expect(result?.structuredContent.complete).toBe(true);
    expect(result?.structuredContent.matches).toContain(path.join(searchDir, "inner", "gamma.txt"));
  });

  test("隐式不可用 → 静默落原生兜底，无 FD warning，不触 exec", async () => {
    vi.mocked(resolveFd).mockResolvedValueOnce({
      available: false,
      source: "path",
      diagnostic: {
        reason: "fd_not_on_path",
        env_name: FD_PATH_ENV,
        download_performed: false,
        source: "path",
        attempted: [{ source: "path", reason: "fd not on PATH" }],
      },
    });

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*report*",
      max_results: 10,
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.matches).toContain(path.join(searchDir, "alpha-report.txt"));
    expect(result?.structuredContent.warnings).toEqual([]);
    expect(result?.structuredContent.complete).toBe(true);
    expect(vi.mocked(execFileManaged)).not.toHaveBeenCalled();
  });

  test("显式路径缺失 → fail-closed VALIDATION_ERROR，不触 exec 不落兜底", async () => {
    process.env[FD_PATH_ENV] = path.join(stateDir, "missing", "fd");
    resetFdResolverCache();

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*.txt",
      max_results: 10,
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({
      code: "VALIDATION_ERROR",
      param: FD_PATH_ENV,
      detail: {
        reason: "explicit_path_missing",
        env_name: FD_PATH_ENV,
        download_performed: false,
      },
    });
    expect(vi.mocked(execFileManaged)).not.toHaveBeenCalled();
  });

  test("abort 信号 → CANCELLED 契约", async () => {
    const ac = new AbortController();
    ac.abort();
    queueFdAvailable();
    vi.mocked(execFileManaged).mockRejectedValueOnce(
      new ManagedProcessError("cancelled", {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        cancelled: true,
        terminationFailed: false,
      }),
    );

    const result = await registerTools()
      .get("search_files")
      ?.handler(
        { dir_path: searchDir, pattern: "*report*", max_results: 10 },
        { requestId: "fd-abort", signal: ac.signal },
      );

    expect(result?.structuredContent.error).toMatchObject({ code: "CANCELLED" });
  });

  test("真实 fd 引擎端到端冒烟（环境无 fd 时软跳过）", async () => {
    // 透传真实 resolver / 真实 execFileManaged，不注入 once 队列
    const resolution = await resolveFd();
    if (!resolution.available) return; // 软跳过：宿主未安装 fd/fdfind

    const result = await registerTools().get("search_files")?.handler({
      dir_path: searchDir,
      pattern: "*gamma*",
      max_results: 10,
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.matches).toContain(path.join(searchDir, "inner", "gamma.txt"));
    expect(result?.structuredContent.complete).toBe(true);
    expect(result?.structuredContent.warnings).toEqual([]);
  });
});
