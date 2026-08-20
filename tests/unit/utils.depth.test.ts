/**
 * utils.ts 深度测试 — safeExecFile 边界
 * （safeExec 的 GBK/替换字符解码路径随 smartDecode 一并移除：spawnStream 统一 UTF-8 输出）
 */
import type { ChildProcess } from "node:child_process";
import { describe, expect, test, vi } from "vitest";

type ExecCallback = (error: Error | null, stdout?: Buffer | string, stderr?: Buffer | string) => void;

// ====================================================================
// safeExecFile 边界测试
// ====================================================================
describe("safeExecFile (edge cases)", () => {
  test("safeExecFile 有 stderr 但无 stdout 仍 resolve", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        setImmediate(() => cb(null, "", "error output"));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
    }));
    const { safeExecFile } = await import("../../src/utils.js");
    const result = await safeExecFile("cmd", [], 5000);
    expect(result.stderr).toBe("error output");
    expect(result.stdout).toBe("");
  });

  test("safeExecFile 默认 toString 处理 buffer", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        // execFile 直接返回 string（不是 buffer）
        setImmediate(() => cb(null, "direct-string", ""));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
    }));
    const { safeExecFile } = await import("../../src/utils.js");
    const result = await safeExecFile("cmd", [], 5000);
    expect(result.stdout).toBe("direct-string");
  });
});
