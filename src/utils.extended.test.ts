/**
 * utils.ts 扩展单元测试 — 包含 child_process mock
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// ====================================================================
// safeExec 和 safeExecFile 测试（mock child_process）
// ====================================================================
describe("safeExec (mocked)", () => {
  let safeExec: Function;

  beforeEach(async () => {
    vi.resetModules();
    // 模拟成功的 exec
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: any, cb: Function) => {
        const stdout = Buffer.from("hello world");
        const stderr = Buffer.from("");
        // 异步回调
        setImmediate(() => cb(null, stdout, stderr));
        return { on: vi.fn() };
      },
      execFile: (_file: string, _args: string[], _opts: any, cb: Function) => {
        setImmediate(() => cb(null, "output", ""));
        return { on: vi.fn() };
      },
    }));

    // 重新 mock platform 中的 shell 以避免 path 依赖
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));

    const mod = await import("./utils.js");
    safeExec = (mod as any).safeExec;
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
  let safeExec: Function;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: any, cb: Function) => {
        const error = { code: 1, message: "command failed" } as any;
        setImmediate(() => cb(error, Buffer.from(""), Buffer.from("")));
        return { on: vi.fn() };
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));
    const mod = await import("./utils.js");
    safeExec = (mod as any).safeExec;
  });

  test("safeExec 命令失败且无输出时 reject", async () => {
    await expect(safeExec("bad-command", 5000)).rejects.toThrow();
  });
});

describe("safeExec (timeout)", () => {
  let safeExec: Function;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: any, cb: Function) => {
        const error = { killed: true, code: null } as any;
        setImmediate(() => cb(error, undefined, undefined));
        return { on: vi.fn() };
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));
    const mod = await import("./utils.js");
    safeExec = (mod as any).safeExec;
  });

  test("safeExec 超时时 reject with Timeout", async () => {
    await expect(safeExec("slow-command", 1000)).rejects.toThrow("Timeout");
  });
});

describe("safeExec (exit code but has output)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: any, cb: Function) => {
        const error = { code: 1 } as any;
        const stdout = Buffer.from("partial output");
        const stderr = Buffer.from("error output");
        setImmediate(() => cb(error, stdout, stderr));
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

  test("safeExec 有 stdout 时即使 exit code≠0 也 resolve", async () => {
    const { safeExec } = await import("./utils.js");
    const result = await safeExec("partial-fail", 5000);
    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toContain("EXIT CODE");
  });
});

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
