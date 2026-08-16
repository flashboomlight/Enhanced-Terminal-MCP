/**
 * utils.ts 深度测试 — safeExecFile 边界
 * （safeExec 的 GBK/替换字符解码路径随 smartDecode 一并移除：spawnStream 统一 UTF-8 输出）
 */
import { describe, expect, test, vi } from "vitest";

// ====================================================================
// safeExecFile 边界测试
// ====================================================================
describe("safeExecFile (edge cases)", () => {
  test("safeExecFile 有 stderr 但无 stdout 仍 resolve", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: any, cb: Function) => {
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
      execFile: (_file: string, _args: string[], _opts: any, cb: Function) => {
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
