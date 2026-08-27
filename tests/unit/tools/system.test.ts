/**
 * system.ts 工具行为单元测试（fake server 直调 handler）
 *
 * 只覆盖无需真实系统调用的决策路径：环境变量脱敏、关键进程保护、
 * 非法 host 校验。会真实 spawn 的 get_system_info / process_list /
 * network_info 成功路径由 e2e 覆盖。
 */
import { afterEach, describe, expect, test } from "vitest";
import { registerSystemTools } from "../../../src/tools/system.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<any>;

function registerTools() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _spec: unknown, handler: ToolHandler) {
      tools.set(name, { handler });
    },
  };
  registerSystemTools(server as any);
  return tools;
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

  test("environment_vars get returns plain values for non-sensitive names", async () => {
    process.env.ETMCP_PLAIN_TEST_VAR = "plain-value";
    customEnv.ETMCP_PLAIN_TEST_VAR = process.env.ETMCP_PLAIN_TEST_VAR;

    const result = await registerTools().get("environment_vars")?.handler({
      action: "get",
      name: "ETMCP_PLAIN_TEST_VAR",
    });

    expect(result?.structuredContent.value).toBe("plain-value");
  });

  test("environment_vars list masks sensitive keys but keeps others", async () => {
    process.env.ETMCP_TEST_TOKEN = "hide-me";
    process.env.ETMCP_TEST_VISIBLE = "show-me";
    customEnv.ETMCP_TEST_TOKEN = process.env.ETMCP_TEST_TOKEN;
    customEnv.ETMCP_TEST_VISIBLE = process.env.ETMCP_TEST_VISIBLE;

    const result = await registerTools().get("environment_vars")?.handler({ action: "list" });

    expect(result?.isError).toBeFalsy();
    const vars = result?.structuredContent.vars as Record<string, string>;
    expect(vars.ETMCP_TEST_TOKEN).toBe("***");
    expect(vars.ETMCP_TEST_VISIBLE).toBe("show-me");
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

  test("network_info rejects invalid ping targets without spawning", async () => {
    const result = await registerTools().get("network_info")?.handler({
      action: "ping",
      target: "not a host; rm -rf",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "HOST_INVALID", param: "target" });
  });
});
