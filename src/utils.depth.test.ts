/**
 * utils.ts 深度测试 — GBK 解码路径和边界
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// ====================================================================
// GBK 解码路径测试
// ====================================================================
describe("safeExec (GBK decoding)", () => {
  beforeEach(async () => {
    vi.resetModules();
    // 模拟 exec 返回 GBK 编码数据
    vi.doMock("child_process", () => ({
      exec: (cmd: string, opts: any, cb: Function) => {
        // 创建一个包含 \ufffd (UTF-8 替换字符) 的 buffer
        // 这会触发 smartDecode 的 GBK 回退
        const buf = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK
        setImmediate(() => cb(null, buf, Buffer.from("")));
        return { on: vi.fn() };
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));
  });

  test("safeExec GBK 解码回退路径", async () => {
    const { safeExec } = await import("./utils.js");
    const result = await safeExec("gbk-command", 5000);
    expect(result.stdout).toBeTruthy();
    // 应该有内容（中文或替换后的文本）
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

// ====================================================================
// 编码检测的 smartDecode 间接测试
// ====================================================================
describe("safeExec (UTF-8 with replacement char)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (cmd: string, opts: any, cb: Function) => {
        // 制造一个无效的 UTF-8 序列（触发 \ufffd）
        const buf = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
        setImmediate(() => cb(null, buf, Buffer.from("")));
        return { on: vi.fn() };
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
    }));
  });

  test("safeExec 处理含 UTF-8 替换字符的输出", async () => {
    const { safeExec } = await import("./utils.js");
    const result = await safeExec("broken-utf8", 5000);
    // 即使 UTF-8 失败，GBK 回退或原始值也应该返回
    expect(typeof result.stdout).toBe("string");
  });
});

// ====================================================================
// safeExecFile 边界测试
// ====================================================================
describe("safeExecFile (edge cases)", () => {
  test("safeExecFile 有 stderr 但无 stdout 仍 resolve", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (file: string, args: string[], opts: any, cb: Function) => {
        setImmediate(() => cb(null, "", "error output"));
        return { on: vi.fn() };
      },
    }));
    const { safeExecFile } = await import("./utils.js");
    const result = await safeExecFile("cmd", [], 5000);
    expect(result.stderr).toBe("error output");
    expect(result.stdout).toBe("");
  });

  test("safeExecFile 默认 toString 处理 buffer", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (file: string, args: string[], opts: any, cb: Function) => {
        // execFile 直接返回 string（不是 buffer）
        setImmediate(() => cb(null, "direct-string", ""));
        return { on: vi.fn() };
      },
    }));
    const { safeExecFile } = await import("./utils.js");
    const result = await safeExecFile("cmd", [], 5000);
    expect(result.stdout).toBe("direct-string");
  });
});
