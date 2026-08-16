/**
 * platform.ts 扩展测试 — 深入测试 CommandSpec 输出
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
} from "./platform.js";
import type { ShellSpec } from "./shell.js";

const IS_WIN = os.platform() === "win32";

// 注入的假 shell spec：单测不依赖本机 PATH（design 2.2 变化-3）
const testShell: ShellSpec = { file: "pwsh-test.exe", flavor: "pwsh", source: "path", version: "7.6.5" };

// ====================================================================
// getKillSpec 详细验证
// ====================================================================
describe("getKillSpec 详细验证", () => {
  test("按 PID 时 file 非空", () => {
    const spec = getKillSpec(9999);
    expect(spec.file.length).toBeGreaterThan(0);
  });

  test("按名称时 file 非空", () => {
    const spec = getKillSpec(undefined, "test-app");
    expect(spec.file.length).toBeGreaterThan(0);
  });

  test("同时提供 pid 和 name 时优先 pid", () => {
    const spec = getKillSpec(1234, "ignored");
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("1234");
    expect(argsStr).not.toContain("ignored");
  });

  test("force 参数独立影响", () => {
    const normal = getKillSpec(1234, undefined, false);
    const forced = getKillSpec(1234, undefined, true);
    expect(normal.args.length).not.toBe(forced.args.length);
  });

  test("Windows 使用 taskkill", () => {
    if (IS_WIN) {
      const spec = getKillSpec(1234);
      expect(spec.file.toLowerCase()).toContain("taskkill");
    }
  });

  test("Unix 使用 kill/pkill", () => {
    if (!IS_WIN) {
      const spec = getKillSpec(1234);
      expect(spec.file).toMatch(/kill/);
    }
  });

  test("Unix 按名称使用 pkill", () => {
    if (!IS_WIN) {
      const spec = getKillSpec(undefined, "test");
      expect(spec.file).toBe("pkill");
    }
  });
});

// ====================================================================
// getNetworkSpec 详细验证
// ====================================================================
describe("getNetworkSpec 详细验证", () => {
  test("ping 使用 4 个包", () => {
    const spec = getNetworkSpec("ping", "1.1.1.1");
    const argsStr = spec.args.join(" ");
    if (IS_WIN) {
      expect(argsStr).toContain("-n");
      expect(argsStr).toContain("4");
    } else {
      expect(argsStr).toContain("-c");
      expect(argsStr).toContain("4");
    }
  });

  test("config 命令有效", () => {
    const spec = getNetworkSpec("config");
    expect(spec.file.length).toBeGreaterThan(0);
    expect(spec.args.length).toBeGreaterThan(0);
  });

  test("dns 使用正确的查询工具", () => {
    const spec = getNetworkSpec("dns", "example.com");
    if (IS_WIN) {
      expect(spec.file).toContain("nslookup");
    }
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("example.com");
  });
});

// ====================================================================
// getCompressSpec / getExtractSpec / getDownloadSpec
// ====================================================================
describe("压缩/解压/下载 CommandSpec", () => {
  test("compress 包含源和目标", () => {
    const spec = getCompressSpec("/src", "/dst.zip", testShell);
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("/src");
    expect(argsStr).toContain("/dst.zip");
    expect(spec.file.length).toBeGreaterThan(0);
  });

  test("extract 包含归档和输出目录", () => {
    const spec = getExtractSpec("/arc.zip", "/out", testShell);
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("/arc.zip");
    expect(argsStr).toContain("/out");
    expect(spec.file.length).toBeGreaterThan(0);
  });

  test("download 包含 URL 和保存路径", () => {
    const spec = getDownloadSpec("https://example.com/a.txt", "/tmp/a.txt", testShell);
    const argsStr = spec.args.join(" ");
    expect(argsStr).toContain("https://example.com/a.txt");
    expect(argsStr).toContain("/tmp/a.txt");
    expect(spec.file.length).toBeGreaterThan(0);
  });
});

// ====================================================================
// getProcessListSpec 详细验证
// ====================================================================
describe("getProcessListSpec 详细验证", () => {
  test("top=5 和 top=50 产生不同参数", () => {
    const s5 = getProcessListSpec(undefined, 5, testShell);
    const s50 = getProcessListSpec(undefined, 50, testShell);
    expect(s5.args).not.toEqual(s50.args);
  });

  test("filter 参数出现在输出中", () => {
    const spec = getProcessListSpec("myapp", 10, testShell);
    const argsStr = spec.args.join(" ");
    if (IS_WIN) {
      expect(argsStr).toContain("myapp");
    } else {
      expect(argsStr).toContain("myapp");
    }
  });
});
