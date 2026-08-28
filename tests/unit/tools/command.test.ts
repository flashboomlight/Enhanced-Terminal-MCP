/**
 * command.ts S5 工具契约与输出语义测试
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { audit } from "../../../src/audit.js";
import { resetCommandOutputLimitsCache } from "../../../src/command-output.js";
import { processSupervisor } from "../../../src/process-supervisor.js";
import { initSafeGuard } from "../../../src/safeguard.js";
import { session } from "../../../src/session.js";
import { resetShellSpecCache } from "../../../src/shell.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { tempManager } from "../../../src/temp-manager.js";
import { registerCommandTools } from "../../../src/tools/command.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<any>;

const ENV_KEYS = [
  "MCP_AUDIT_MODE",
  "MCP_COMMAND_MEMORY_OUTPUT_BYTES",
  "MCP_COMMAND_MAX_OUTPUT_BYTES",
  "MCP_COMMAND_MAX_STDERR_BYTES",
  "MCP_SHELL",
  "MCP_SECRETS_SCAN",
  "MCP_STATE_DIR",
  "MCP_TEMP_MAX_TOTAL_BYTES",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const TMP_DIR = fileURLToPath(new URL("../../../.etmcp/test-tmp/", import.meta.url));
const tools = new Map<string, ToolHandler>();
const fakeServer = {
  registerTool(name: string, _spec: unknown, handler: ToolHandler) {
    tools.set(name, handler);
  },
};

let stateDir = "";
let scriptDir = "";

function handler(name: string): ToolHandler {
  const found = tools.get(name);
  if (!found) throw new Error(`Missing test tool: ${name}`);
  return found;
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  return handler(name)(args);
}

async function callWithExtra(
  name: string,
  args: Record<string, unknown>,
  extra: { requestId: string; signal: AbortSignal },
): Promise<any> {
  return handler(name)(args, extra);
}

async function writeScript(name: string, source: string): Promise<string> {
  const file = path.join(scriptDir, name);
  await fs.writeFile(file, source, "utf8");
  return file;
}

function scriptCommand(file: string): string {
  // 项目路径含空格且 cmd 链路无法安全携带引号路径：
  // 命令串只放 basename，配合 cwd: scriptDir 解析（见各调用点）
  return `node ${path.basename(file)}`;
}

function setCommandShell(shell: "cmd" | "powershell" | "pwsh"): void {
  if (process.platform === "win32") process.env.MCP_SHELL = shell;
  else delete process.env.MCP_SHELL;
  resetShellSpecCache();
}

function structured(result: any): Record<string, any> {
  return result.structuredContent as Record<string, any>;
}

beforeAll(() => {
  process.env.MCP_SAFETY_MODE = "off";
  process.env.MCP_AUDIT_MODE = "off";
  initSafeGuard(fakeServer as any);
  registerCommandTools(fakeServer as any);
});

beforeEach(async () => {
  await fs.mkdir(TMP_DIR, { recursive: true });
  stateDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-command-tools-state-"));
  scriptDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-command-tools-scripts-"));
  process.env.MCP_STATE_DIR = stateDir;
  process.env.MCP_COMMAND_MEMORY_OUTPUT_BYTES = "1048576";
  process.env.MCP_COMMAND_MAX_OUTPUT_BYTES = "52428800";
  process.env.MCP_COMMAND_MAX_STDERR_BYTES = "1048576";
  process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1073741824";
  process.env.MCP_SECRETS_SCAN = "off";
  process.env.MCP_AUDIT_MODE = "off";
  resetStateDirCache();
  resetCommandOutputLimitsCache();
  setCommandShell("cmd");
  session.reset();
  await session.flush();
});

afterEach(async () => {
  await session.flush();
  tempManager.stopAutoCleanup();
  resetShellSpecCache();
  resetCommandOutputLimitsCache();
  resetStateDirCache();
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(scriptDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  delete process.env.MCP_SAFETY_MODE;
});

describe("execute_command contract", () => {
  test("requires exactly one execution or cache mode", async () => {
    const missing = await call("execute_command", {});
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent.error.code).toBe("VALIDATION_ERROR");

    const both = await call("execute_command", { command: "echo x", cache_id: "page-cache-invalid" });
    expect(both.isError).toBe(true);
    expect(both.structuredContent.error.code).toBe("VALIDATION_ERROR");

    const commandPage = await call("execute_command", { command: "echo x", page: 2 });
    expect(commandPage.isError).toBe(true);
    expect(commandPage.structuredContent.error.code).toBe("VALIDATION_ERROR");

    const cacheCwd = await call("execute_command", { cache_id: "page-cache-invalid", cwd: TMP_DIR });
    expect(cacheCwd.isError).toBe(true);
    expect(cacheCwd.structuredContent.error.code).toBe("VALIDATION_ERROR");
  });

  test("cancels a running command through MCP RequestContext signal", async () => {
    const script = await writeScript("cancel.js", "setTimeout(() => {}, 5000)");
    const controller = new AbortController();
    const pending = callWithExtra(
      "execute_command",
      { command: scriptCommand(script), cwd: scriptDir },
      { requestId: "cancel-test", signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    const result = await pending;
    const output = structured(result);

    expect(result.isError).toBe(true);
    expect(output.error.code).toBe("CANCELLED");
    expect(output.cancelled).toBe(true);
    // taskkill 控制进程按 design 纳管在 registry 中，属于瞬态 child；等待其自然退出后再断言无泄漏。
    await vi.waitFor(() => expect(processSupervisor.getActiveSnapshots()).toEqual([]), {
      timeout: 5000,
      interval: 25,
    });
  }, 10000);

  test("returns over-2000-character output in memory without creating a cache", async () => {
    const script = await writeScript("small.js", "process.stdout.write('x'.repeat(4000))");
    const result = await call("execute_command", { command: scriptCommand(script), cwd: scriptDir, pageSize: 2000 });
    const envelope = structured(result);

    expect(result.isError).toBeFalsy();
    expect(envelope.ok).toBe(true);
    expect(envelope.stdout).toHaveLength(4000);
    expect(envelope.total_chars).toBe(4000);
    expect(envelope.paged).toBe(false);
    expect(envelope.truncated).toBe(false);
    expect(envelope.cache_id).toBeUndefined();
    await expect(fs.access(path.join(stateDir, "temp"))).rejects.toThrow();
  });

  test("spills only after the memory threshold and reads later pages without rerunning", async () => {
    const script = await writeScript(
      "large.js",
      "process.stdout.write('A'.repeat(700000)); process.stdout.write('B'.repeat(500000))",
    );
    const result = await call("execute_command", { command: scriptCommand(script), cwd: scriptDir, pageSize: 2000 });
    const first = structured(result);

    expect(result.isError).toBeFalsy();
    expect(first.ok).toBe(true);
    expect(first.paged).toBe(true);
    expect(first.truncated).toBe(false);
    expect(first.cache_id).toMatch(/^page-cache-\d{13}-[0-9a-f]{32}$/);
    expect(first.total_output_bytes).toBe(1200000);
    expect(first.page).toBe(1);
    expect(first.total_pages).toBe(600);

    const cacheDir = path.join(stateDir, "temp", first.cache_id);
    expect((await fs.readdir(cacheDir)).sort()).toEqual(["meta.json", "stderr.bin", "stdout.bin", "stdout.idx"]);

    const secondResult = await call("execute_command", { cache_id: first.cache_id, page: 2, pageSize: 2000 });
    const second = structured(secondResult);
    expect(secondResult.isError).toBeFalsy();
    expect(second.ok).toBe(true);
    expect(second.page).toBe(2);
    expect(second.stdout).toBe("A".repeat(2000));
    expect(second.stderr).toBe("");
  });

  test("reads a failed command cache successfully while preserving its original error envelope", async () => {
    const script = await writeScript("failed.js", "process.stdout.write('f'.repeat(1100000)); process.exitCode = 2");
    const failed = await call("execute_command", { command: scriptCommand(script), cwd: scriptDir, pageSize: 2000 });
    const failedEnvelope = structured(failed);

    expect(failed.isError).toBe(true);
    expect(failedEnvelope.ok).toBe(false);
    expect(failedEnvelope.error.code).toBe("EXECUTION_FAILED");
    expect(failedEnvelope.exit_code).toBe(2);
    expect(failedEnvelope.cache_id).toBeTruthy();

    const page = await call("execute_command", { cache_id: failedEnvelope.cache_id, page: 2 });
    const pageEnvelope = structured(page);
    expect(page.isError).toBeFalsy();
    expect(pageEnvelope.ok).toBe(false);
    expect(pageEnvelope.error.code).toBe("EXECUTION_FAILED");
    expect(pageEnvelope.exit_code).toBe(2);
    expect(pageEnvelope.stderr).toBe("");
  });
});

describe("batch and watch contracts", () => {
  test("batch reports skipped commands and stable counters", async () => {
    const failScript = await writeScript("batch-fail.js", "process.exitCode = 3");
    const result = await call("batch_execute", {
      commands: [scriptCommand(failScript), "echo should-not-run"],
      cwd: scriptDir,
      stop_on_error: true,
      parallel: false,
    });
    const output = structured(result);

    expect(result.isError).toBeFalsy();
    expect(output.results).toHaveLength(2);
    expect(output.results[0].status).toBe("completed");
    expect(output.results[0].ok).toBe(false);
    expect(output.results[1]).toEqual({
      index: 1,
      command: "echo should-not-run",
      status: "skipped",
      skip_reason: "stop_on_error",
    });
    expect(output.completed).toBe(1);
    expect(output.failed).toBe(1);
    expect(output.skipped).toBe(1);
    expect(output.all_ok).toBe(false);
  });

  test("watch duration is a normal capture window, not a timeout", async () => {
    const script = await writeScript("watch.js", "setTimeout(() => {}, 5000)");
    const result = await call("watch_command", { command: scriptCommand(script), cwd: scriptDir, duration: 100 });
    const output = structured(result);

    expect(result.isError).toBeFalsy();
    expect(output.ok).toBe(true);
    expect(output.timed_out).toBe(false);
    expect(output.capture_limit_reached).toBe(true);
  });
});

describe("secret and shell output contracts", () => {
  test("strict secret detection returns SECRET_DETECTED with suppressed structured output", async () => {
    process.env.MCP_SECRETS_SCAN = "strict";
    resetCommandOutputLimitsCache();
    const script = await writeScript("secret.js", "process.stdout.write('sk-' + 'x'.repeat(32))");
    const result = await call("execute_command", { command: scriptCommand(script), cwd: scriptDir });
    const output = structured(result);

    expect(result.isError).toBe(true);
    expect(output.error.code).toBe("SECRET_DETECTED");
    expect(output.stdout).toBe("");
    expect(output.stderr).toBe("");
    expect(output.retained_output_bytes).toBe(0);
    expect(output.total_chars).toBe(0);
    expect(output.cache_id).toBeUndefined();
  });

  test.skipIf(process.platform !== "win32")(
    "decodes Chinese output consistently across cmd, powershell, and pwsh",
    async () => {
      for (const shell of ["cmd", "powershell", "pwsh"] as const) {
        setCommandShell(shell);
        const result = await call("execute_command", { command: "echo 中文测试" });
        const output = structured(result);
        expect(result.isError).toBeFalsy();
        expect(output.stdout).toContain("中文测试");
        expect(output.stdout).not.toContain("���");
      }
    },
  );
});

describe("command.output.read audit", () => {
  test("records only cache/page/read metrics", async () => {
    process.env.MCP_AUDIT_MODE = "all";
    const script = await writeScript("audited.js", "process.stdout.write('a'.repeat(1100000))");
    const first = await call("execute_command", { command: scriptCommand(script), cwd: scriptDir, pageSize: 2000 });
    const cacheId = structured(first).cache_id as string;
    await call("execute_command", { cache_id: cacheId, page: 2 });
    await audit.flush();

    const entry = (await audit.recent(100)).find((item) => item.action === "command.output.read");
    expect(entry).toBeDefined();
    expect(entry?.detail).toMatchObject({ cache_id: cacheId, page: 2 });
    expect(entry?.detail).not.toHaveProperty("command");
    expect(entry?.detail).not.toHaveProperty("cwd");
  });
});

describe("bounded command execution", () => {
  test("rejects non-finite and out-of-range timeout before any side effect", async () => {
    for (const timeout of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
      const result = await call("execute_command", { command: "echo hi", timeout });
      expect(result.isError).toBe(true);
      expect(structured(result).error.code).toBe("VALIDATION_ERROR");
      expect(structured(result).error.message).toMatch(/timeout/);
    }
  });

  test("rejects oversized command input by chars and UTF-8 bytes", async () => {
    const result = await call("execute_command", { command: "a".repeat(70000) });
    expect(result.isError).toBe(true);
    expect(structured(result).error.code).toBe("VALIDATION_ERROR");

    const byteResult = await call("execute_command", { command: "中".repeat(70000) });
    expect(byteResult.isError).toBe(true);
    expect(structured(byteResult).error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects non-finite watch duration and oversized watch command", async () => {
    const durationResult = await call("watch_command", { command: "echo hi", duration: Number.POSITIVE_INFINITY });
    expect(durationResult.isError).toBe(true);
    expect(structured(durationResult).error.code).toBe("VALIDATION_ERROR");

    const commandResult = await call("watch_command", { command: "a".repeat(70000) });
    expect(commandResult.isError).toBe(true);
    expect(structured(commandResult).error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects batch arrays beyond the item limit", async () => {
    const result = await call("batch_execute", { commands: Array.from({ length: 101 }, () => "echo hi") });
    expect(result.isError).toBe(true);
    expect(structured(result).error.code).toBe("VALIDATION_ERROR");
    expect(structured(result).error.message).toMatch(/commands/);
  });

  test("rejects batch input aggregate over budget with zero execution", async () => {
    // 每条 ~22KB、共 100 条 ≈ 2.2MB > 2MiB 聚合上限；schema 单项与条数均合法
    const big = "echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".padEnd(22000, "x");
    const result = await call("batch_execute", { commands: Array.from({ length: 100 }, () => big) });
    expect(result.isError).toBe(true);
    expect(structured(result).error.code).toBe("RESOURCE_LIMIT");
    expect(structured(result).error.detail).toMatchObject({ limit: 2_097_152 });
  });

  test("ordinary commands keep their envelope semantics", async () => {
    const result = await call("execute_command", { command: "echo bounded-ok" });
    expect(result.isError).toBeFalsy();
    const envelope = structured(result);
    expect(envelope.ok).toBe(true);
    expect(envelope.stdout).toContain("bounded-ok");
  });
});
