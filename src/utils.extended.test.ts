/**
 * utils.ts 扩展单元测试 — 包含 child_process mock
 */
import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { safeExecFile as SafeExecFileType, safeExec as SafeExecType } from "./utils.js";

type ExecCallback = (error: Error | null, stdout?: Buffer | string, stderr?: Buffer | string) => void;

// ====================================================================
// safeExec 和 safeExecFile 测试（mock child_process）
// ====================================================================
describe("safeExec (mocked)", () => {
  let safeExec: typeof SafeExecType;

  beforeEach(async () => {
    vi.resetModules();
    // 模拟成功的 exec
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: unknown, cb: ExecCallback) => {
        const stdout = Buffer.from("hello world");
        const stderr = Buffer.from("");
        // 异步回调
        setImmediate(() => cb(null, stdout, stderr));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
      execFile: (_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        setImmediate(() => cb(null, "output", ""));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
    }));

    // 重新 mock platform 中的 shell 以避免 path 依赖
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));

    const mod = await import("./utils.js");
    safeExec = mod.safeExec;
  });

  test("safeExec 正常执行返回 stdout", async () => {
    const result = await safeExec("echo hello", 5000);
    expect(result.stdout).toBe("hello world");
  });

  test("safeExec 返回空 stderr", async () => {
    const result = await safeExec("echo hello", 5000);
    expect(result.stderr).toBe("");
  });
});

describe("safeExec (error cases)", () => {
  let safeExec: typeof SafeExecType;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: unknown, cb: ExecCallback) => {
        const error = Object.assign(new Error("command failed"), { code: 1 });
        setImmediate(() => cb(error, Buffer.from(""), Buffer.from("")));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));
    const mod = await import("./utils.js");
    safeExec = mod.safeExec;
  });

  test("safeExec 命令失败且无输出时 reject", async () => {
    await expect(safeExec("bad-command", 5000)).rejects.toThrow();
  });
});

describe("safeExec (timeout)", () => {
  let safeExec: typeof SafeExecType;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: unknown, cb: ExecCallback) => {
        const error = Object.assign(new Error("timeout"), { killed: true, code: null });
        setImmediate(() => cb(error, undefined, undefined));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));
    const mod = await import("./utils.js");
    safeExec = mod.safeExec;
  });

  test("safeExec 超时时 reject with Timeout", async () => {
    await expect(safeExec("slow-command", 1000)).rejects.toThrow("Timeout");
  });
});

describe("safeExec (exit code but has output)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: unknown, cb: ExecCallback) => {
        const error = Object.assign(new Error("command failed"), { code: 1 });
        const stdout = Buffer.from("partial output");
        const stderr = Buffer.from("error output");
        setImmediate(() => cb(error, stdout, stderr));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));
  });

  test("safeExec 有 stdout 时即使 exit code≠0 也 resolve", async () => {
    const { safeExec } = await import("./utils.js");
    const result = await safeExec("partial-fail", 5000);
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toContain("EXIT CODE");
  });
});

describe("safeExecFile (mocked)", () => {
  let safeExecFile: typeof SafeExecFileType;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        setImmediate(() => cb(null, "file-output", ""));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
    }));
    const mod = await import("./utils.js");
    safeExecFile = mod.safeExecFile;
  });

  test("safeExecFile 正常执行返回 stdout", async () => {
    const result = await safeExecFile("ls", ["-la"], 5000);
    expect(result.stdout).toBe("file-output");
  });

  test("safeExecFile 错误但无输出时 reject", async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: vi.fn(),
      execFile: (_file: string, _args: string[], _opts: unknown, cb: ExecCallback) => {
        const error = new Error("not found");
        setImmediate(() => cb(error, "", ""));
        return { on: vi.fn() } as unknown as ChildProcess;
      },
    }));
    const mod = await import("./utils.js");
    const sf = mod.safeExecFile;
    await expect(sf("nonexistent", [], 5000)).rejects.toThrow("not found");
  });
});
