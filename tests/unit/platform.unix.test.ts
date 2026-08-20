/**
 * platform.ts Unix 分支覆盖测试（在 Windows 上通过 mock node:os 模拟 Linux）
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: () => "linux",
  };
});

const {
  getCompressSpec,
  getDownloadSpec,
  getExtractSpec,
  getKillSpec,
  getNetworkSpec,
  getProcessListSpec,
  getShell,
  getSystemInfoSpec,
  IS_WIN,
  wrapCommand,
} = await import("../../src/platform.js");

describe("platform Unix branches", () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    delete process.env.SHELL;
  });

  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  test("IS_WIN is false under mocked Linux", () => {
    expect(IS_WIN).toBe(false);
  });

  test("getShell returns /bin/sh by default", () => {
    expect(getShell()).toBe("/bin/sh");
  });

  test("getShell prefers SHELL env", () => {
    process.env.SHELL = "/bin/zsh";
    expect(getShell()).toBe("/bin/zsh");
  });

  test("wrapCommand returns command unchanged on Unix", () => {
    expect(wrapCommand("echo hello")).toBe("echo hello");
  });

  test("getProcessListSpec without filter on Unix", () => {
    const spec = getProcessListSpec(undefined, 10);
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("ps aux");
  });

  test("getProcessListSpec with filter on Unix", () => {
    const spec = getProcessListSpec("node", 10);
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("node");
  });

  test("getProcessListSpec with sanitized-empty filter falls back", () => {
    const spec = getProcessListSpec(";;;", 10);
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("ps aux");
  });

  test("getKillSpec by pid on Unix", () => {
    const spec = getKillSpec(1234);
    expect(spec.file).toBe("kill");
    expect(spec.args).toContain("1234");
  });

  test("getKillSpec by pid force on Unix", () => {
    const spec = getKillSpec(1234, undefined, true);
    expect(spec.file).toBe("kill");
    expect(spec.args).toContain("-9");
  });

  test("getKillSpec by name on Unix uses pkill", () => {
    const spec = getKillSpec(undefined, "node");
    expect(spec.file).toBe("pkill");
    expect(spec.args).toContain("node");
  });

  test("getNetworkSpec config on Unix", () => {
    const spec = getNetworkSpec("config");
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("ifconfig");
  });

  test("getNetworkSpec connections on Unix", () => {
    const spec = getNetworkSpec("connections");
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("netstat");
  });

  test("getNetworkSpec ping on Unix", () => {
    const spec = getNetworkSpec("ping", "1.1.1.1");
    expect(spec.file).toBe("ping");
    expect(spec.args).toContain("-c");
    expect(spec.args).toContain("1.1.1.1");
  });

  test("getNetworkSpec dns on Unix", () => {
    const spec = getNetworkSpec("dns", "example.com");
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("nslookup");
    expect(spec.args[1]).toContain("example.com");
  });

  test("getNetworkSpec unknown action on Unix falls back", () => {
    const spec = getNetworkSpec("unknown");
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("ifconfig");
  });

  test("getCompressSpec on Unix uses zip", () => {
    const spec = getCompressSpec("/src", "/dst.zip");
    expect(spec.file).toBe("zip");
    expect(spec.args).toContain("/src");
    expect(spec.args).toContain("/dst.zip");
  });

  test("getExtractSpec on Unix uses unzip", () => {
    const spec = getExtractSpec("/arc.zip", "/out");
    expect(spec.file).toBe("unzip");
    expect(spec.args).toContain("/arc.zip");
    expect(spec.args).toContain("/out");
  });

  test("getSystemInfoSpec on Unix uses /bin/sh", () => {
    const spec = getSystemInfoSpec();
    expect(spec.file).toBe("/bin/sh");
    expect(spec.args[1]).toContain("uname");
    // mocked platform is linux → /proc path (mac uses sysctl)
    expect(spec.args[1]).toContain("/proc/cpuinfo");
  });

  test("getDownloadSpec on Unix uses curl", () => {
    const spec = getDownloadSpec("https://example.com/a.txt", "/tmp/a.txt");
    expect(spec.file).toBe("curl");
    expect(spec.args).toContain("https://example.com/a.txt");
    expect(spec.args).toContain("/tmp/a.txt");
  });
});
