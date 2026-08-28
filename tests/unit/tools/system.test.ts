/**
 * system.ts 工具行为单元测试（fake server 直调 handler）
 *
 * 只覆盖无需真实系统调用的决策路径：环境变量脱敏、关键进程保护、
 * 非法 host 校验。会真实 spawn 的 get_system_info / process_list /
 * network_info 成功路径由 e2e 覆盖。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProcessIdentity, ProcessIdentityProvider } from "../../../src/process-identity.js";
import { Errors } from "../../../src/result.js";
import { initSafeGuard } from "../../../src/safeguard.js";
import { registerSystemTools } from "../../../src/tools/system.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<any>;

function registerTools(dependencies: { processIdentityProvider?: ProcessIdentityProvider } = {}) {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _spec: unknown, handler: ToolHandler) {
      tools.set(name, { handler });
    },
  };
  registerSystemTools(server as any, dependencies);
  return tools;
}

const fakeIdentity: ProcessIdentity = {
  pid: 99_999,
  name: "worker",
  startedAt: 100,
  token: "fake:100",
  ownedByCurrentWorker: false,
};

function fakeProvider(overrides: Partial<ProcessIdentityProvider> = {}): ProcessIdentityProvider {
  return {
    findByExactName: vi.fn(async () => [fakeIdentity]),
    inspectPid: vi.fn(async () => fakeIdentity),
    terminate: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function withSafetyOff<T>(callback: () => Promise<T>): Promise<T> {
  const previous = process.env.MCP_SAFETY_MODE;
  process.env.MCP_SAFETY_MODE = "off";
  initSafeGuard({} as any);
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.MCP_SAFETY_MODE;
    else process.env.MCP_SAFETY_MODE = previous;
  }
}

describe("system tools decision paths (unit)", () => {
  const customEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const key of Object.keys(customEnv)) delete process.env[key];
  });

  test("environment_vars get masks sensitive variable names", async () => {
    process.env.MY_API_KEY = "super-secret-value";
    customEnv.MY_API_KEY = process.env.MY_API_KEY;

    const result = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "MY_API_KEY",
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.value).toBe("***");
    expect(result?.content[0].text).toContain("*** (hidden)");
  });

  test("environment_vars get returns values for built-in allowlist keys, redacted", async () => {
    process.env.PATH = process.env.PATH || "C:\\tools";
    const result = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "PATH",
    });
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent.value).toBe(process.env.PATH);
  });

  test("environment_vars get masks non-allowlisted keys by default (allowlist mode)", async () => {
    process.env.ETMCP_PLAIN_TEST_VAR = "plain-value";
    customEnv.ETMCP_PLAIN_TEST_VAR = process.env.ETMCP_PLAIN_TEST_VAR;

    const result = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "ETMCP_PLAIN_TEST_VAR",
    });
    expect(result?.structuredContent.value).toBe("***");
    expect(result?.content[0].text).toContain("*** (hidden)");
  });

  test("environment_vars get honors MCP_ENV_VALUE_ALLOWLIST extras and full mode", async () => {
    process.env.ETMCP_PLAIN_TEST_VAR = "plain-value";
    customEnv.ETMCP_PLAIN_TEST_VAR = process.env.ETMCP_PLAIN_TEST_VAR;
    const originalMode = process.env.MCP_ENV_VALUE_MODE;
    const originalAllowlist = process.env.MCP_ENV_VALUE_ALLOWLIST;

    process.env.MCP_ENV_VALUE_ALLOWLIST = "etmcp_plain_test_var";
    const allowlisted = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "ETMCP_PLAIN_TEST_VAR",
    });
    expect(allowlisted?.structuredContent.value).toBe("plain-value");

    process.env.MCP_ENV_VALUE_MODE = "full";
    delete process.env.MCP_ENV_VALUE_ALLOWLIST;
    const full = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "ETMCP_PLAIN_TEST_VAR",
    });
    expect(full?.structuredContent.value).toBe("plain-value");

    process.env.MCP_ENV_VALUE_MODE = "keys";
    const keys = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "ETMCP_PLAIN_TEST_VAR",
    });
    expect(keys?.structuredContent.value).toBe("***");

    if (originalMode === undefined) delete process.env.MCP_ENV_VALUE_MODE;
    else process.env.MCP_ENV_VALUE_MODE = originalMode;
    if (originalAllowlist === undefined) delete process.env.MCP_ENV_VALUE_ALLOWLIST;
    else process.env.MCP_ENV_VALUE_ALLOWLIST = originalAllowlist;
  });

  test("environment_vars list masks sensitive and non-allowlisted keys in default mode", async () => {
    process.env.ETMCP_TEST_TOKEN = "hide-me";
    process.env.ETMCP_TEST_VISIBLE = "show-me";
    customEnv.ETMCP_TEST_TOKEN = process.env.ETMCP_TEST_TOKEN;
    customEnv.ETMCP_TEST_VISIBLE = process.env.ETMCP_TEST_VISIBLE;

    const result = await registerTools().get("environment_vars")?.handler({ action: "list" });
    expect(result?.isError).toBeFalsy();
    const vars = result?.structuredContent.vars as Record<string, string>;
    expect(vars.ETMCP_TEST_TOKEN).toBe("***");
    expect(vars.ETMCP_TEST_VISIBLE).toBe("***");

    const originalMode = process.env.MCP_ENV_VALUE_MODE;
    process.env.MCP_ENV_VALUE_MODE = "full";
    try {
      const full = await registerTools().get("environment_vars")?.handler({ action: "list" });
      const fullVars = full?.structuredContent.vars as Record<string, string>;
      expect(fullVars.ETMCP_TEST_TOKEN).toBe("***"); // sensitive 恒掩码
      expect(fullVars.ETMCP_TEST_VISIBLE).toBe("show-me");
    } finally {
      if (originalMode === undefined) delete process.env.MCP_ENV_VALUE_MODE;
      else process.env.MCP_ENV_VALUE_MODE = originalMode;
    }
  });

  test("network_info ping target is rejected by SSRF policy in deny-private mode", async () => {
    const original = process.env.MCP_SSRF_MODE;
    process.env.MCP_SSRF_MODE = "deny-private";
    try {
      const result = await registerTools().get("network_info")?.handler({ action: "ping", target: "127.0.0.1" });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent.error).toMatchObject({ code: "SSRF_BLOCKED", param: "url" });
    } finally {
      if (original === undefined) delete process.env.MCP_SSRF_MODE;
      else process.env.MCP_SSRF_MODE = original;
    }
  });

  test("kill_process refuses critical system processes before any execution", async () => {
    const result = await registerTools().get("kill_process")?.handler({ pid: 4 });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PROCESS_PROTECTED" });
  });

  test("kill_process refuses critical process names", async () => {
    const result = await registerTools().get("kill_process")?.handler({ name: "csrss.exe" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "PROCESS_PROTECTED" });
  });

  test("kill_process rejects wildcard and dual targets before provider side effects", async () => {
    const provider = fakeProvider();
    const result = await registerTools({ processIdentityProvider: provider }).get("kill_process")?.handler({
      pid: 99999,
      name: "worker*",
    });

    expect(result?.structuredContent.error).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(provider.findByExactName).not.toHaveBeenCalled();
    expect(provider.inspectPid).not.toHaveBeenCalled();
    expect(provider.terminate).not.toHaveBeenCalled();
  });

  test("kill_process refuses ambiguous exact name without terminating", async () => {
    const provider = fakeProvider({ findByExactName: async () => [fakeIdentity, { ...fakeIdentity, pid: 100_000 }] });
    const result = await withSafetyOff(() =>
      registerTools({ processIdentityProvider: provider })
        .get("kill_process")
        ?.handler({ name: "worker", force: true }),
    );

    expect(result?.structuredContent.error).toMatchObject({ code: "PROCESS_IDENTITY_AMBIGUOUS" });
    expect(provider.terminate).not.toHaveBeenCalled();
  });

  test("kill_process binds unique identity before termination and reports tree mode", async () => {
    const terminate = vi.fn(async () => undefined);
    const provider = fakeProvider({ terminate });
    const result = await withSafetyOff(() =>
      registerTools({ processIdentityProvider: provider })
        .get("kill_process")
        ?.handler({ name: "worker", force: true }),
    );

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ killed: true, pid: fakeIdentity.pid, tree: true });
    expect(terminate).toHaveBeenCalledWith(fakeIdentity, true, true);
  });

  test("kill_process propagates identity mismatch and never reports success", async () => {
    const provider = fakeProvider({ inspectPid: async () => Errors.processIdentityAmbiguous("PID reuse") });
    const result = await withSafetyOff(() =>
      registerTools({ processIdentityProvider: provider }).get("kill_process")?.handler({ pid: 99999 }),
    );

    expect(result?.structuredContent.error).toMatchObject({ code: "PROCESS_IDENTITY_AMBIGUOUS" });
    expect(provider.terminate).not.toHaveBeenCalled();
  });

  test("kill_process protects the current server pid before provider inspection", async () => {
    const provider = fakeProvider();
    const result = await registerTools({ processIdentityProvider: provider }).get("kill_process")?.handler({
      pid: process.pid,
    });

    expect(result?.structuredContent.error).toMatchObject({ code: "PROCESS_PROTECTED" });
    expect(provider.inspectPid).not.toHaveBeenCalled();
    expect(provider.terminate).not.toHaveBeenCalled();
  });

  test("network_info rejects invalid ping targets without spawning", async () => {
    const result = await registerTools().get("network_info")?.handler({
      action: "ping",
      target: "not a host; rm -rf",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "HOST_INVALID", param: "target" });
  });
});
