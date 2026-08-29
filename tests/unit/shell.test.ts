/**
 * shell.ts 单元测试 — 解析器全量注入候选，跨平台确定性运行
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { IS_WIN } from "../../src/platform.js";
import {
  buildShellInvocation,
  getShellSpec,
  powerShellTarget,
  type ResolveShellOptions,
  resetShellSpecCache,
  resolveShell,
  ShellResolutionError,
} from "../../src/shell.js";
import { spawnStream } from "../../src/stream.js";

// 常用注入：默认假设 nothing exists（各用例按需覆盖）
function opts(over: Partial<ResolveShellOptions> = {}): ResolveShellOptions {
  return {
    env: {},
    projectRoot: "D:\\fake-root",
    exists: () => false,
    which: () => null,
    probeVersion: async () => null,
    ...over,
  };
}

afterEach(() => {
  resetShellSpecCache();
});

// ====================================================================
// resolveShell：mode 与优先级
// ====================================================================
describe("resolveShell 优先级", () => {
  test("默认 pwsh 模式：bundled 存在且探测成功 → source=bundled", async () => {
    const spec = await resolveShell(
      opts({
        exists: (p) => p === "D:\\fake-root\\tools\\pwsh\\pwsh.exe",
        probeVersion: async () => "7.6.5",
      }),
    );
    expect(spec).toEqual({
      file: "D:\\fake-root\\tools\\pwsh\\pwsh.exe",
      flavor: "pwsh",
      source: "bundled",
      version: "7.6.5",
    });
  });

  test("显式路径胜出于 bundled 与 PATH pwsh", async () => {
    const probed: string[] = [];
    const spec = await resolveShell(
      opts({
        env: { MCP_POWERSHELL_PATH: "D:\\explicit\\pwsh.exe" },
        exists: () => true,
        which: () => "C:\\Windows\\pwsh.exe",
        probeVersion: async (f) => {
          probed.push(f);
          return "7.4.1";
        },
      }),
    );
    expect(spec).toEqual({ file: "D:\\explicit\\pwsh.exe", flavor: "pwsh", source: "explicit", version: "7.4.1" });
    // 显式路径命中后不再探测其他候选
    expect(probed).toEqual(["D:\\explicit\\pwsh.exe"]);
  });

  test("无 bundled、PATH 有 pwsh 7 → source=path", async () => {
    const spec = await resolveShell(
      opts({
        which: (n) => (n === "pwsh.exe" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null),
        probeVersion: async () => "7.6.5",
      }),
    );
    expect(spec.source).toBe("path");
    expect(spec.flavor).toBe("pwsh");
    expect(spec.file).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  test("无 pwsh 7、有 5.1 → 回退 fallback + flavor=powershell", async () => {
    const spec = await resolveShell(
      opts({
        which: (n) =>
          n === "powershell.exe" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : null,
        probeVersion: async (f) => (f.includes("v1.0") ? "5.1.26100.1" : null),
      }),
    );
    expect(spec).toEqual({
      file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      flavor: "powershell",
      source: "fallback",
      version: "5.1.26100.1",
    });
  });

  test("bundled 探测失败 → 记录后继续 PATH 候选", async () => {
    const spec = await resolveShell(
      opts({
        exists: (p) => p === "D:\\fake-root\\tools\\pwsh\\pwsh.exe",
        which: (n) => (n === "pwsh.exe" ? "C:\\PATH\\pwsh.exe" : null),
        probeVersion: async (f) => (f === "C:\\PATH\\pwsh.exe" ? "7.5.0" : null),
      }),
    );
    expect(spec.source).toBe("path");
  });

  test("MCP_SHELL=cmd → cmd 兼容档，不探测任何候选", async () => {
    let probes = 0;
    const spec = await resolveShell(
      opts({
        env: { MCP_SHELL: "cmd" },
        probeVersion: async () => {
          probes++;
          return "7.6.5";
        },
      }),
    );
    expect(spec).toEqual({ file: "cmd.exe", flavor: "cmd", source: "compat" });
    expect(probes).toBe(0);
  });

  test("MCP_SHELL=powershell → 不尝试 bundled/PATH pwsh", async () => {
    const probed: string[] = [];
    const spec = await resolveShell(
      opts({
        env: { MCP_SHELL: "powershell" },
        exists: () => true, // bundled 存在也不该被尝试
        which: (n) => (n === "pwsh.exe" ? "C:\\PATH\\pwsh.exe" : "C:\\WINPS\\powershell.exe"),
        probeVersion: async (f) => {
          probed.push(f);
          return f.includes("WINPS") ? "5.1.26100.1" : "7.6.5";
        },
      }),
    );
    expect(spec.source).toBe("system");
    expect(spec.flavor).toBe("powershell");
    expect(probed).toEqual(["C:\\WINPS\\powershell.exe"]);
  });

  test("显式路径指向 5.1 → flavor=powershell（按探测主版本判定）", async () => {
    const spec = await resolveShell(
      opts({
        env: { MCP_POWERSHELL_PATH: "D:\\explicit\\powershell.exe" },
        exists: () => true,
        probeVersion: async () => "5.1.26100.1",
      }),
    );
    expect(spec.flavor).toBe("powershell");
    expect(spec.source).toBe("explicit");
  });
});

// ====================================================================
// resolveShell：错误分支（场景 8/9/10）
// ====================================================================
describe("resolveShell 错误分支", () => {
  test("非法 MCP_SHELL → INVALID_SHELL_MODE，不回退默认", async () => {
    await expect(resolveShell(opts({ env: { MCP_SHELL: "bash" } }))).rejects.toMatchObject({
      code: "INVALID_SHELL_MODE",
    });
  });

  test("显式路径不存在 → SHELL_PATH_INVALID，不继续候选", async () => {
    let probes = 0;
    await expect(
      resolveShell(
        opts({
          env: { MCP_POWERSHELL_PATH: "D:\\missing\\pwsh.exe" },
          exists: (p) => p === "D:\\fake-root\\tools\\pwsh\\pwsh.exe", // bundled 存在也不该被尝试
          probeVersion: async () => {
            probes++;
            return "7.6.5";
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "SHELL_PATH_INVALID" });
    expect(probes).toBe(0);
  });

  test("显式路径为相对路径 → SHELL_PATH_INVALID", async () => {
    await expect(resolveShell(opts({ env: { MCP_POWERSHELL_PATH: "tools/pwsh/pwsh.exe" } }))).rejects.toMatchObject({
      code: "SHELL_PATH_INVALID",
    });
  });

  test("显式路径版本探测失败 → SHELL_PATH_INVALID", async () => {
    await expect(
      resolveShell(
        opts({
          env: { MCP_POWERSHELL_PATH: "D:\\broken\\pwsh.exe" },
          exists: () => true,
          probeVersion: async () => null,
        }),
      ),
    ).rejects.toMatchObject({ code: "SHELL_PATH_INVALID" });
  });

  test("全部候选失败 → SHELL_NOT_FOUND，附非敏感 attempted 来源", async () => {
    const err = (await resolveShell(opts()).catch((e: unknown) => e)) as ShellResolutionError;
    expect(err).toBeInstanceOf(ShellResolutionError);
    expect(err.code).toBe("SHELL_NOT_FOUND");
    expect(err.attempted.map((a) => a.source)).toEqual(["bundled", "path", "fallback"]);
    // 错误信息不含环境变量原值
    expect(err.message).not.toContain("fake-root");
  });

  test("SHELL_NOT_FOUND 消息包含可操作建议", async () => {
    const err = (await resolveShell(opts()).catch((e: unknown) => e)) as ShellResolutionError;
    expect(err.message).toContain("setup.bat");
    expect(err.message).toContain("MCP_SHELL=cmd");
  });

  test("MCP_SHELL=powershell 且无 5.1 → SHELL_NOT_FOUND", async () => {
    await expect(resolveShell(opts({ env: { MCP_SHELL: "powershell" } }))).rejects.toMatchObject({
      code: "SHELL_NOT_FOUND",
    });
  });
});

// ====================================================================
// getShellSpec：进程级缓存（场景 11 + 失败缓存）
// ====================================================================
describe("getShellSpec 缓存", () => {
  test.skipIf(!IS_WIN)("并发首次调用 → 只探测一次，结果共享", async () => {
    let probes = 0;
    const injected = opts({
      exists: () => true,
      which: () => null,
      probeVersion: async () => {
        probes++;
        return "7.6.5";
      },
    });
    const [a, b] = await Promise.all([getShellSpec(injected), getShellSpec(injected)]);
    expect(a).toBe(b);
    expect(a.source).toBe("bundled");
    expect(probes).toBe(1);
  });

  test.skipIf(!IS_WIN)("解析失败也缓存：第二次调用不再探测", async () => {
    let probes = 0;
    const injected = opts({
      probeVersion: async () => {
        probes++;
        return null;
      },
    });
    await expect(getShellSpec(injected)).rejects.toMatchObject({ code: "SHELL_NOT_FOUND" });
    await expect(getShellSpec(injected)).rejects.toMatchObject({ code: "SHELL_NOT_FOUND" });
    expect(probes).toBe(0); // 无候选存在，探测从未发生
  });

  test("resetShellSpecCache 后可重新解析", async () => {
    if (!IS_WIN) return;
    const first = opts({ exists: () => true, which: () => null, probeVersion: async () => "7.6.5" });
    const a = await getShellSpec(first);
    expect(a.version).toBe("7.6.5");
    resetShellSpecCache();
    const second = opts({ env: { MCP_SHELL: "cmd" } });
    const b = await getShellSpec(second);
    expect(b.flavor).toBe("cmd");
  });
});

// ====================================================================
// buildShellInvocation：flavor → 参数/编码
// ====================================================================
describe("buildShellInvocation", () => {
  const pwshSpec = {
    file: "D:\\tools\\pwsh\\pwsh.exe",
    flavor: "pwsh" as const,
    source: "bundled" as const,
    version: "7.6.5",
  };

  test("pwsh → -NoLogo -NoProfile -NonInteractive -Command + UTF-8 preamble", () => {
    const inv = buildShellInvocation("Write-Output 你好", pwshSpec);
    expect(inv.file).toBe("D:\\tools\\pwsh\\pwsh.exe");
    expect(inv.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output 你好",
    ]);
  });

  test("powershell 5.1 → 追加 UTF-8 preamble", () => {
    const inv = buildShellInvocation("Get-Date", { file: "powershell.exe", flavor: "powershell", source: "fallback" });
    expect(inv.args[0]).toBe("-NoProfile");
    expect(inv.args[2]).toBe("-Command");
    expect(inv.args[3]).toContain("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8");
    expect(inv.args[3].endsWith("Get-Date")).toBe(true);
  });

  test("cmd → verbatim /d /s /c + 整体引号（chcp 65001 前缀）", () => {
    const inv = buildShellInvocation("echo hello", { file: "cmd.exe", flavor: "cmd", source: "compat" });
    expect(inv.args).toEqual(["/d", "/s", "/c", `"chcp 65001 >nul && echo hello"`]);
    expect(inv.windowsVerbatimArguments).toBe(true);
  });

  test("unix → -c", () => {
    const inv = buildShellInvocation("ls -la", { file: "/bin/sh", flavor: "unix", source: "compat" });
    expect(inv.args).toEqual(["-c", "ls -la"]);
  });
});

// ====================================================================
// powerShellTarget：平台 spec 的 PS 执行目标
// ====================================================================
describe("powerShellTarget", () => {
  test("pwsh flavor → 统一基础参数", () => {
    const t = powerShellTarget({ file: "D:\\pwsh.exe", flavor: "pwsh", source: "bundled", version: "7.6.5" });
    expect(t).toEqual({ file: "D:\\pwsh.exe", baseArgs: ["-NoLogo", "-NoProfile", "-NonInteractive"] });
  });

  test("powershell flavor → 5.1 基础参数", () => {
    const t = powerShellTarget({ file: "C:\\ps\\powershell.exe", flavor: "powershell", source: "fallback" });
    expect(t).toEqual({ file: "C:\\ps\\powershell.exe", baseArgs: ["-NoProfile", "-NonInteractive"] });
  });

  test("cmd 兼容档 → 回退 v3.1 的 powershell.exe", () => {
    const t = powerShellTarget({ file: "cmd.exe", flavor: "cmd", source: "compat" });
    expect(t).toEqual({ file: "powershell.exe", baseArgs: ["-NoProfile"] });
  });
});

// ====================================================================
// cmd flavor 引号空格路径回归（issue 2026-08-29-cmd-quoted-space-path）
// 真实 spawn：verbatim + /d /s /c + 整体引号形态下，含引号空格路径与普通命令均正确执行
// ====================================================================
describe("cmd flavor quoted-space path", () => {
  const itWin = IS_WIN ? test : test.skip;

  itWin("type 带引号的空格路径文件成功输出内容", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cmd-quote-issue-"));
    const filePath = path.join(dir, "probe dir with space", "probe file.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "CMD-QUOTE-OK", "utf8");
    try {
      const inv = buildShellInvocation(`type "${filePath}"`, { file: "cmd.exe", flavor: "cmd", source: "compat" });
      const r = await spawnStream(inv.file, inv.args, {
        timeout: 15000,
        windowsVerbatimArguments: inv.windowsVerbatimArguments,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("CMD-QUOTE-OK");
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  itWin("无引号普通命令在 verbatim 形态下不受影响", async () => {
    const inv = buildShellInvocation("echo PLAIN-OK", { file: "cmd.exe", flavor: "cmd", source: "compat" });
    const r = await spawnStream(inv.file, inv.args, {
      timeout: 15000,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("PLAIN-OK");
  });
});
