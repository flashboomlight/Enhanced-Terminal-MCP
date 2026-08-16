/**
 * utils.ts 扩展单元测试 — safeExec 走统一 shell spec（真实 spawnStream，固定注入 spec）
 */
import * as os from "node:os";
import { beforeEach, describe, expect, test, vi } from "vitest";

const IS_WIN = os.platform() === "win32";
// 固定注入 spec：不依赖本机 PATH / pwsh 安装状态
const FIXED_SPEC = IS_WIN
  ? { file: "cmd.exe", flavor: "cmd" as const, source: "compat" as const }
  : { file: "/bin/sh", flavor: "unix" as const, source: "compat" as const };

async function loadSafeExec() {
  vi.resetModules();
  vi.doMock("./shell.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./shell.js")>();
    return { ...actual, getShellSpec: async () => FIXED_SPEC };
  });
  const mod = await import("./utils.js");
  return mod.safeExec;
}

// ====================================================================
// safeExec — 统一 shell spec（真实执行）
// ====================================================================
describe("safeExec (统一 shell spec)", () => {
  beforeEach(() => {
    vi.unmock("./shell.js");
  });

  test("正常执行返回 stdout 与空 stderr", async () => {
    const safeExec = await loadSafeExec();
    const result = await safeExec("echo hello", 10000);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  test("exit≠0 且无输出时 reject", async () => {
    const safeExec = await loadSafeExec();
    await expect(safeExec("exit 1", 10000)).rejects.toThrow(/Exit code 1/);
  });

  test("超时 reject Timeout", async () => {
    const safeExec = await loadSafeExec();
    const slow = IS_WIN ? "ping -n 10 127.0.0.1" : "sleep 10";
    await expect(safeExec(slow, 500)).rejects.toThrow(/Timeout/);
  }, 15000);

  test("有输出时即使 exit≠0 也 resolve 并附 EXIT CODE 标记", async () => {
    const safeExec = await loadSafeExec();
    const partial = IS_WIN ? "echo partial & echo err 1>&2 & exit 3" : "echo partial; echo err 1>&2; exit 3";
    const result = await safeExec(partial, 10000);
    expect(result.stdout.trim()).toBe("partial");
    expect(result.stderr).toContain("err");
    expect(result.stderr).toContain("EXIT CODE");
  });
});

// ====================================================================
// safeExecFile（mocked — 行为未变，保持原测试）
// ====================================================================
describe("safeExecFile (mocked)", () => {
  let safeExecFile: Function;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: any, cb: Function) => {
        setImmediate(() => cb(null, "file-output", ""));
        return { on: vi.fn() };
      },
    }));
    const mod = await import("./utils.js");
    safeExecFile = (mod as any).safeExecFile;
  });

  test("safeExecFile 正常执行返回 stdout", async () => {
    const result = await safeExecFile("ls", ["-la"], 5000);
    expect(result.stdout).toBe("file-output");
  });

  test("safeExecFile 错误但无输出时 reject", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: any, cb: Function) => {
        const error = new Error("not found");
        setImmediate(() => cb(error, "", ""));
        return { on: vi.fn() };
      },
    }));
    const mod = await import("./utils.js");
    const sf = (mod as any).safeExecFile;
    await expect(sf("nonexistent", [], 5000)).rejects.toThrow("not found");
  });
});
