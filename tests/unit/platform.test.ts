/**
 * platform.ts 单元测试
 */

import * as os from "node:os";
import { describe, expect, test } from "vitest";
import {
  getCompressSpec,
  getDownloadSpec,
  getExtractSpec,
  getKillSpec,
  getNetworkSpec,
  getProcessListSpec,
  getShell,
  getSystemInfoSpec,
  IS_LINUX,
  IS_MAC,
  IS_WIN,
  wrapCommand,
} from "../../src/platform.js";
import type { ShellSpec } from "../../src/shell.js";

// 注入的假 shell spec：单测不依赖本机 PATH（design 2.2 变化-3）
const testShell: ShellSpec = { file: "pwsh-test.exe", flavor: "pwsh", source: "path", version: "7.6.5" };

// ====================================================================
// 平台常量
// ====================================================================
describe("平台常量", () => {
  test("IS_WIN 与 os.platform() 一致", () => {
    expect(IS_WIN).toBe(os.platform() === "win32");
  });

  test("IS_MAC 与 os.platform() 一致", () => {
    expect(IS_MAC).toBe(os.platform() === "darwin");
  });

  test("IS_LINUX 与 os.platform() 一致", () => {
    expect(IS_LINUX).toBe(os.platform() === "linux");
  });
});

// ====================================================================
// getShell
// ====================================================================
describe("getShell", () => {
  test("Windows 返回 cmd.exe", () => {
    if (IS_WIN) {
      expect(getShell()).toBe("cmd.exe");
    }
  });

  test("Unix 返回 /bin/sh 或 SHELL 环境变量", () => {
    if (!IS_WIN) {
      const shell = getShell();
      expect(shell).toBeTruthy();
      expect(typeof shell).toBe("string");
    }
  });
});

// ====================================================================
// wrapCommand
// ====================================================================
describe("wrapCommand", () => {
  test("Windows 下包装为 chcp 65001", () => {
    if (IS_WIN) {
      const wrapped = wrapCommand("echo hello");
      expect(wrapped).toContain("chcp 65001");
      expect(wrapped).toContain("echo hello");
      expect(wrapped).toContain("&&");
    }
  });

  test("Unix 下不修改命令", () => {
    if (!IS_WIN) {
      expect(wrapCommand("echo hello")).toBe("echo hello");
    }
  });

  test("getProcessListSpec handles empty sanitized filter on Unix", () => {
    if (!IS_WIN) {
      const spec = getProcessListSpec(";;;", 10, testShell);
      expect(spec.file).toBeTruthy();
    }
  });

  test("getKillSpec rejects missing or invalid verified pid", () => {
    expect(() => getKillSpec(undefined as unknown as number)).toThrow("requires a verified positive pid");
    expect(() => getKillSpec(0)).toThrow("requires a verified positive pid");
  });

  test("getKillSpec rejects an unverified name-shaped argument", () => {
    expect(() => (getKillSpec as unknown as (pid: number, force: unknown) => unknown)(1234, "node")).toThrow(
      "force and tree must be boolean",
    );
  });

  test("getNetworkSpec uses default hosts", () => {
    if (!IS_WIN) {
      const cfg = getNetworkSpec("config");
      expect(cfg.args[1]).toContain("ifconfig");
      const conn = getNetworkSpec("connections");
      expect(conn.args[1]).toContain("netstat");
      const dns = getNetworkSpec("dns");
      expect(dns.args[1]).toContain("localhost");
    }
  });

  test("getSystemInfoSpec returns valid CommandSpec", () => {
    const spec = getSystemInfoSpec(testShell);
    expect(spec.file).toBeTruthy();
    expect(spec.args.length).toBeGreaterThan(0);
  });
});

// ====================================================================
// getProcessListSpec
// ====================================================================
describe("getProcessListSpec", () => {
  test("无 filter 返回有效 CommandSpec", () => {
    const spec = getProcessListSpec(undefined, 20, testShell);
    expect(spec.file).toBeTruthy();
    expect(spec.args.length).toBeGreaterThan(0);
  });

  test("有 filter 返回包含过滤的 CommandSpec", () => {
    const spec = getProcessListSpec("node", 10, testShell);
    expect(spec.file).toBeTruthy();
    expect(spec.args.length).toBeGreaterThan(0);
  });

  test("top 参数影响输出", () => {
    const spec5 = getProcessListSpec(undefined, 5, testShell);
    const spec50 = getProcessListSpec(undefined, 50, testShell);
    // top 数字出现在参数中
    const args5 = spec5.args.join(" ");
    const args50 = spec50.args.join(" ");
    expect(args5).not.toBe(args50);
  });
});

// ====================================================================
// getKillSpec
// ====================================================================
describe("getKillSpec", () => {
  test("按 PID 杀进程返回有效 CommandSpec", () => {
    const spec = getKillSpec(1234);
    expect(spec.file).toBeTruthy();
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("1234");
  });

  test("只允许 verified PID 生成终止 CommandSpec", () => {
    const spec = getKillSpec(1234, true, true);
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("1234");
    expect(argsStr).not.toMatch(/\/IM|pkill/i);
  });

  test("force 模式包含强制参数", () => {
    const spec = getKillSpec(1234, true);
    const argsStr = spec.args.join(" ").toLowerCase();
    if (IS_WIN) {
      expect(argsStr).toContain("/f");
    } else {
      expect(argsStr).toContain("-9");
    }
  });

  test("非 force 模式使用温和信号", () => {
    if (!IS_WIN) {
      const spec = getKillSpec(1234, false);
      const argsStr = spec.args.join(" ");
      expect(argsStr).toContain("-15");
    }
  });
});

// ====================================================================
// getNetworkSpec
// ====================================================================
describe("getNetworkSpec", () => {
  test("config 返回配置命令", () => {
    const spec = getNetworkSpec("config");
    expect(spec.file).toBeTruthy();
    expect(spec.args.length).toBeGreaterThan(0);
  });

  test("connections 返回连接命令", () => {
    const spec = getNetworkSpec("connections");
    expect(spec.file).toBeTruthy();
    expect(spec.args.length).toBeGreaterThan(0);
  });

  test("ping 包含目标主机", () => {
    const spec = getNetworkSpec("ping", "8.8.8.8");
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("8.8.8.8");
  });

  test("dns 包含目标主机", () => {
    const spec = getNetworkSpec("dns", "example.com");
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("example.com");
  });

  test("ping 默认目标为 127.0.0.1", () => {
    const spec = getNetworkSpec("ping");
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("127.0.0.1");
  });

  test("未知 action 返回 fallback", () => {
    const spec = getNetworkSpec("unknown");
    expect(spec.file).toBeTruthy();
  });
});

// ====================================================================
// getCompressSpec
// ====================================================================
describe("getCompressSpec", () => {
  test("返回有效 CommandSpec", () => {
    const spec = getCompressSpec("/tmp/source", "/tmp/output.zip", testShell);
    expect(spec.file).toBeTruthy();
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("/tmp/source");
    expect(argsStr).toContain("/tmp/output.zip");
  });
});

// ====================================================================
// getExtractSpec
// ====================================================================
describe("getExtractSpec", () => {
  test("返回有效 CommandSpec", () => {
    const spec = getExtractSpec("/tmp/archive.zip", "/tmp/extracted", testShell);
    expect(spec.file).toBeTruthy();
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("/tmp/archive.zip");
    expect(argsStr).toContain("/tmp/extracted");
  });
});

// ====================================================================
// getDownloadSpec
// ====================================================================
describe("getDownloadSpec", () => {
  test("返回有效 CommandSpec", () => {
    const spec = getDownloadSpec("https://example.com/file.txt", "/tmp/file.txt", testShell);
    expect(spec.file).toBeTruthy();
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("https://example.com/file.txt");
    expect(argsStr).toContain("/tmp/file.txt");
  });
});
