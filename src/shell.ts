// src/shell.ts — shell 解析与调用构造的统一归属（platform.ts 兼容重导出旧 getShell/wrapCommand）
import { statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { IS_WIN } from "./platform.js";
import { ErrorCode, fail, type ToolResult } from "./result.js";
import { spawnStream } from "./stream.js";

// ====================================================================
// 名词层：ShellMode / ShellSpec / ShellInvocation / 解析错误
// ====================================================================

export type ShellMode = "pwsh" | "powershell" | "cmd";

/** 实际执行器类别（unix 为非 Windows 分支的固定档，不进入 Windows 候选流程） */
export type ShellFlavor = "pwsh" | "powershell" | "cmd" | "unix";

/**
 * spec 来源：
 * explicit=MCP_POWERSHELL_PATH 显式路径 bundled=项目便携包 path=PATH pwsh
 * fallback=pwsh 模式回退 5.1 system=显式 powershell 模式 compat=cmd/unix 兼容档
 */
export type ShellSource = "explicit" | "bundled" | "path" | "fallback" | "system" | "compat";

export interface ShellSpec {
  file: string;
  flavor: ShellFlavor;
  source: ShellSource;
  version?: string;
}

export interface ShellInvocation {
  file: string;
  args: string[];
  /** cmd flavor 下为 true：spawn 必须按 verbatim 拼接命令行，否则 Node 的 CRT 转义会把内嵌引号写成 \" 破坏 cmd 解析。 */
  windowsVerbatimArguments?: boolean;
}

export type ShellErrorCode = "INVALID_SHELL_MODE" | "SHELL_PATH_INVALID" | "SHELL_NOT_FOUND";

/** 非敏感的候选尝试记录（不含环境变量原值） */
export interface ShellAttempt {
  source: ShellSource;
  reason: string;
}

export class ShellResolutionError extends Error {
  readonly code: ShellErrorCode;
  readonly attempted: ShellAttempt[];

  constructor(code: ShellErrorCode, message: string, attempted: ShellAttempt[] = []) {
    super(message);
    this.name = "ShellResolutionError";
    this.code = code;
    this.attempted = attempted;
  }
}

// ====================================================================
// 解析器：纯选择逻辑，候选依赖全部可注入
// ====================================================================

export interface ResolveShellOptions {
  /** 环境变量来源（默认 process.env），消费 MCP_SHELL / MCP_POWERSHELL_PATH */
  env?: Record<string, string | undefined>;
  /** 项目根目录（默认包根），bundled pwsh 位于 <root>/tools/pwsh/pwsh.exe */
  projectRoot?: string;
  /** 路径存在性检查（默认 statSync + isFile） */
  exists?: (p: string) => boolean;
  /** PATH 查找（默认 where.exe） */
  which?: (name: string) => string | null | Promise<string | null>;
  /** 版本探测（默认 spawn $PSVersionTable.PSVersion，失败返回 null） */
  probeVersion?: (file: string) => Promise<string | null>;
}

function defaultProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

async function defaultWhich(name: string): Promise<string | null> {
  try {
    const result = await spawnStream("where", [name], {
      timeout: 5000,
      maxOutput: 4096,
      kind: "shell-probe",
    });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

async function defaultProbeVersion(file: string): Promise<string | null> {
  try {
    const r = await spawnStream(
      file,
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      { timeout: 8000, maxOutput: 4096 },
    );
    if (r.exitCode !== 0 || r.timedOut) return null;
    const v = r.stdout.trim();
    return /^\d+(\.\d+)+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * 纯 Windows shell 解析：按 mode 确定执行器，不读写全局缓存。
 * 优先级：mode=cmd → cmd 兼容档；mode=powershell → 仅 Windows PowerShell 5.1；
 * mode=pwsh → 显式路径（fail closed）→ bundled pwsh 7 → PATH pwsh 7 → 回退 5.1。
 * 非 Windows 平台不调用本函数（getShellSpec 直接返回固定 unix spec）。
 */
export async function resolveShell(options: ResolveShellOptions = {}): Promise<ShellSpec> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? defaultExists;
  const which = options.which ?? defaultWhich;
  const probe = options.probeVersion ?? defaultProbeVersion;

  const mode = env.MCP_SHELL || "pwsh";
  if (mode !== "pwsh" && mode !== "powershell" && mode !== "cmd") {
    throw new ShellResolutionError(
      "INVALID_SHELL_MODE",
      `MCP_SHELL must be one of pwsh|powershell|cmd, got: '${mode}'`,
    );
  }

  if (mode === "cmd") {
    return { file: "cmd.exe", flavor: "cmd", source: "compat" };
  }

  if (mode === "powershell") {
    const file = await which("powershell.exe");
    if (!file) {
      throw new ShellResolutionError("SHELL_NOT_FOUND", "Windows PowerShell (powershell.exe) not found", [
        { source: "system", reason: "powershell.exe not on PATH" },
      ]);
    }
    const version = await probe(file);
    if (!version) {
      throw new ShellResolutionError(
        "SHELL_NOT_FOUND",
        `Windows PowerShell found but version probe failed: '${file}'`,
        [{ source: "system", reason: "version probe failed" }],
      );
    }
    return { file, flavor: "powershell", source: "system", version };
  }

  // mode = pwsh
  const attempted: ShellAttempt[] = [];

  const explicit = env.MCP_POWERSHELL_PATH;
  if (explicit) {
    // 显式路径 fail closed：任何失败直接 SHELL_PATH_INVALID，不继续自动候选
    if (!path.isAbsolute(explicit)) {
      throw new ShellResolutionError(
        "SHELL_PATH_INVALID",
        "MCP_POWERSHELL_PATH must be an absolute file path (got a relative path)",
      );
    }
    if (!exists(explicit)) {
      throw new ShellResolutionError("SHELL_PATH_INVALID", `MCP_POWERSHELL_PATH file not found: '${explicit}'`);
    }
    const version = await probe(explicit);
    if (!version) {
      throw new ShellResolutionError("SHELL_PATH_INVALID", `MCP_POWERSHELL_PATH version probe failed: '${explicit}'`);
    }
    const major = Number(version.split(".")[0]);
    return { file: explicit, flavor: major >= 7 ? "pwsh" : "powershell", source: "explicit", version };
  }

  // bundled → PATH → 5.1 逐个尝试，失败记录原因后继续下一项
  const bundled = path.join(options.projectRoot ?? defaultProjectRoot(), "tools", "pwsh", "pwsh.exe");
  if (exists(bundled)) {
    const version = await probe(bundled);
    if (version) return { file: bundled, flavor: "pwsh", source: "bundled", version };
    attempted.push({ source: "bundled", reason: "version probe failed" });
  } else {
    attempted.push({ source: "bundled", reason: "tools/pwsh/pwsh.exe not found" });
  }

  const pathPwsh = await which("pwsh.exe");
  if (pathPwsh) {
    const version = await probe(pathPwsh);
    if (version) return { file: pathPwsh, flavor: "pwsh", source: "path", version };
    attempted.push({ source: "path", reason: "version probe failed" });
  } else {
    attempted.push({ source: "path", reason: "pwsh.exe not on PATH" });
  }

  const ps51 = await which("powershell.exe");
  if (ps51) {
    const version = await probe(ps51);
    if (version) return { file: ps51, flavor: "powershell", source: "fallback", version };
    attempted.push({ source: "fallback", reason: "version probe failed" });
  } else {
    attempted.push({ source: "fallback", reason: "powershell.exe not on PATH" });
  }

  throw new ShellResolutionError(
    "SHELL_NOT_FOUND",
    "No usable shell found. Run setup.bat to install bundled pwsh 7, put pwsh on PATH, or set MCP_SHELL=cmd|powershell.",
    attempted,
  );
}

// ====================================================================
// 进程级缓存入口
// ====================================================================

const UNIX_SPEC: ShellSpec = { file: "/bin/sh", flavor: "unix", source: "compat" };

let shellSpecPromise: Promise<ShellSpec> | null = null;

/**
 * 获取当前 shell spec（进程级缓存）。
 * 首次解析（成功或失败）后缓存到进程退出；环境变量变化、安装新 pwsh 后需重启 server。
 * options 仅在缓存未建立时生效（供测试注入）。
 */
export function getShellSpec(options?: ResolveShellOptions): Promise<ShellSpec> {
  if (!IS_WIN) return Promise.resolve(UNIX_SPEC);
  if (!shellSpecPromise) {
    shellSpecPromise = resolveShell(options).then(
      (spec) => {
        if (spec.source === "fallback") {
          logger.warn("shell", "fallback", `pwsh 7 not found — using Windows PowerShell ${spec.version ?? ""}`.trim());
        } else {
          logger.info(
            "shell",
            "resolved",
            `flavor=${spec.flavor} source=${spec.source} version=${spec.version ?? "n/a"}`,
          );
        }
        return spec;
      },
      (err: unknown) => {
        logger.error("shell", "resolve-failed", err instanceof Error ? err.message : String(err));
        throw err;
      },
    );
  }
  return shellSpecPromise;
}

/** 清空进程级缓存（测试用） */
export function resetShellSpecCache(): void {
  shellSpecPromise = null;
}

// ====================================================================
// 调用构造：唯一的 flavor → spawn 参数/编码转换入口
// ====================================================================

/** PowerShell 的 UTF-8 输出前缀（pwsh 7 与 5.1 在中文 Windows 管道输出下均需要，实测 2026-08-16） */
const PS_UTF8_PREAMBLE =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ";

export function buildShellInvocation(command: string, spec: ShellSpec): ShellInvocation {
  switch (spec.flavor) {
    case "pwsh":
      return {
        file: spec.file,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PS_UTF8_PREAMBLE + command],
      };
    case "powershell":
      return { file: spec.file, args: ["-NoProfile", "-NonInteractive", "-Command", PS_UTF8_PREAMBLE + command] };
    case "cmd":
      // cmd.exe 不按 MS CRT 规则解引号：Node 默认 argv 转义会把内嵌引号写成 \"，
      // 与 /c 的引号剥除规则冲突（含引号的空格路径必坏，见 issue 2026-08-29-cmd-quoted-space-path）。
      // verbatim + /d /s /c + 整体引号是 npm/cross-spawn 同款标准形态：/d 隔离 AutoRun，
      // /s 让 cmd 只剥最外层一对引号，内部引号原样保留。
      return {
        file: spec.file,
        args: ["/d", "/s", "/c", `"${wrapCommand(command)}"`],
        windowsVerbatimArguments: true,
      };
    case "unix":
      return { file: spec.file, args: ["-c", command] };
  }
}

// ====================================================================
// 平台 spec 的 PowerShell 执行目标
// ====================================================================

/** PS 内部命令（Compress-Archive / Get-Process 等）的执行目标：file + 基础参数 */
export interface PowerShellTarget {
  file: string;
  baseArgs: string[];
}

/**
 * 把 ShellSpec 适配为平台 spec 用的 PowerShell 目标。
 * cmd 兼容档下 PS 脚本无法运行，回退 v3.1 的 powershell.exe 行为；
 * unix spec 不消费本函数（平台 spec 的 PS 分支仅在 Windows 走到）。
 */
export function powerShellTarget(spec: ShellSpec): PowerShellTarget {
  if (spec.flavor === "pwsh") {
    return { file: spec.file, baseArgs: ["-NoLogo", "-NoProfile", "-NonInteractive"] };
  }
  if (spec.flavor === "powershell") {
    return { file: spec.file, baseArgs: ["-NoProfile", "-NonInteractive"] };
  }
  return { file: "powershell.exe", baseArgs: ["-NoProfile"] };
}

// ====================================================================
// 工具层共享：ShellResolutionError → 结构化失败结果
// ====================================================================

/** 是 shell 解析错误则返回结构化失败结果，否则返回 null（调用方走通用错误路径） */
export function shellResolutionFail(e: unknown): ToolResult<unknown> | null {
  if (!(e instanceof ShellResolutionError)) return null;
  return fail(ErrorCode.EXECUTION_FAILED, `[${e.code}] ${e.message}`, {
    retryable: false,
    suggestion: "Fix MCP_SHELL / MCP_POWERSHELL_PATH or run setup.bat, then restart the server",
    detail: { attempted: e.attempted },
  });
}

// ====================================================================
// 旧兼容接口（safeExec / pool 消费，platform.ts 重导出）
// ====================================================================

/**
 * 获取当前平台的默认 shell（仅在 safeExec 内部使用）
 */
export function getShell(): string {
  if (IS_WIN) return "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

/**
 * 构建平台适配的完整命令（Windows 切换代码页为 UTF-8 以避免乱码）
 * 使用 && 而非 &，确保 chcp 失败时不继续执行
 */
export function wrapCommand(cmd: string): string {
  if (IS_WIN) {
    return `chcp 65001 >nul && ${cmd}`;
  }
  return cmd;
}
