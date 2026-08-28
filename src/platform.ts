// src/platform.ts — 跨平台抽象层：命令 / 搜索引擎选择（shell 选择已移至 shell.ts，此处兼容重导出）
import { platform } from "node:os";
import { sanitizeProcessName } from "./security.js";
import { powerShellTarget, type ShellSpec } from "./shell.js";

export const IS_WIN = platform() === "win32";
export const IS_MAC = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

// shell 选择与包装的唯一归属在 shell.ts；重导出保持既有 import 兼容
export { getShell, wrapCommand } from "./shell.js";

/**
 * 统一的命令规格：file + args (用于 execFile)
 * useShell=true 时表示该命令依赖 shell 特性（管道/重定向/通配），
 * 使用 safeExec 走 shell；参数需在上游严格校验。
 */
export interface CommandSpec {
  file: string;
  args: string[];
  useShell?: boolean;
  shellCommand?: string; // 若 useShell=true，这里放最终拼好的 shell 命令
}

/**
 * 构造 Unix 进程列表命令串（纯函数，IS_WIN 不敏感，跨平台可单测）。
 * 先筛选再按 %MEM（ps aux 第 4 列）倒序截断 top N；不使用 GNU --sort 扩展（macOS/BSD 一致）；
 * 表头经 tail -n +2 排除单独输出；filter 经 sanitizeProcessName 消毒后单引号包裹。
 */
export function buildUnixProcessListCommand(filter: string | undefined, top: number): string {
  const safeFilter = filter ? sanitizeProcessName(filter) : "";
  const header = "ps aux 2>/dev/null | head -n 1";
  const body = safeFilter
    ? `ps aux 2>/dev/null | tail -n +2 | grep -i -- '${safeFilter}' | grep -v grep | sort -k4,4 -rn | head -n ${top}`
    : `ps aux 2>/dev/null | tail -n +2 | sort -k4,4 -rn | head -n ${top}`;
  return `${header}; ${body}`;
}

/**
 * 获取进程列表命令（返回 CommandSpec，execFile 执行）
 * Windows: 用 PowerShell Get-Process 并按 WorkingSet 倒序
 * Unix: buildUnixProcessListCommand（先筛选再排序截断）
 * @param shell Windows 下 PS 执行目标来源（由调用方传入解析后的 ShellSpec）
 */
export function getProcessListSpec(filter: string | undefined, top: number, shell: ShellSpec): CommandSpec {
  if (IS_WIN) {
    const ps = powerShellTarget(shell);
    const safeFilter = filter ? sanitizeProcessName(filter) : "";
    const filterClause = safeFilter
      ? `Get-Process | Where-Object { $_.ProcessName -like '*${safeFilter}*' }`
      : "Get-Process";
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      `$procs = ${filterClause};`,
      "$procs | Sort-Object -Property WorkingSet64 -Descending |",
      `  Select-Object -First ${top} Id, ProcessName, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, @{N='CPU';E={[math]::Round($_.CPU,1)}} |`,
      "  Format-Table -AutoSize | Out-String",
    ].join(" ");
    return {
      file: ps.file,
      args: [...ps.baseArgs, "-Command", script],
    };
  }
  // Unix: 通过 /bin/sh -c 执行，filter 消毒与空值回落在 buildUnixProcessListCommand 内处理
  return { file: "/bin/sh", args: ["-c", buildUnixProcessListCommand(filter, top)] };
}

/**
 * 获取 verified PID 的 kill 命令（返回 CommandSpec）。
 *
 * name 不属于此兼容入口；进程名称必须先经过 ProcessIdentityProvider 唯一枚举，
 * 由 provider 绑定 identity 后决定实际终止方式。
 */
export function getKillSpec(pid: number, force = false, tree = false): CommandSpec {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) {
    throw new Error("getKillSpec requires a verified positive pid");
  }
  if (typeof force !== "boolean" || typeof tree !== "boolean") {
    throw new Error("getKillSpec force and tree must be boolean");
  }
  if (IS_WIN) {
    const args = ["/PID", String(pid)];
    if (tree) args.push("/T");
    if (force) args.push("/F");
    return { file: "taskkill", args };
  }
  const sig = force ? "-9" : "-15";
  return tree ? { file: "kill", args: [sig, "--", `-${pid}`] } : { file: "kill", args: [sig, String(pid)] };
}

/**
 * 获取网络命令（返回 CommandSpec）
 * target 必须在上游用 validateHost 校验
 */
export function getNetworkSpec(action: string, target?: string): CommandSpec {
  const host = target || (action === "ping" ? "127.0.0.1" : "localhost");
  if (IS_WIN) {
    switch (action) {
      case "config":
        return { file: "ipconfig", args: ["/all"] };
      case "connections":
        return { file: "netstat", args: ["-an"] };
      case "ping":
        return { file: "ping", args: ["-n", "4", host] };
      case "dns":
        return { file: "nslookup", args: [host] };
      default:
        return { file: "ipconfig", args: [] };
    }
  }
  switch (action) {
    case "config":
      // 先试 ifconfig，失败退 ip addr（通过 /bin/sh -c 编排，但不接用户输入）
      return { file: "/bin/sh", args: ["-c", "ifconfig 2>/dev/null || ip addr"] };
    case "connections":
      return { file: "/bin/sh", args: ["-c", "netstat -an 2>/dev/null || ss -an"] };
    case "ping":
      return { file: "ping", args: ["-c", "4", host] };
    case "dns":
      // host 已通过 validateHost 限制为 [a-zA-Z0-9.\-:]，单引号安全
      return { file: "/bin/sh", args: ["-c", `nslookup '${host}' 2>/dev/null || dig '${host}'`] };
    default:
      return { file: "/bin/sh", args: ["-c", "ifconfig 2>/dev/null || ip addr"] };
  }
}

/**
 * PowerShell 单引号字符串转义：处理 ' 和 $（$ 在单引号内不展开，但为安全起见仍转义）
 * 单引号内唯一需要转义的是单引号本身（'' 表示字面量 '）
 * 注意：PowerShell 单引号字符串内 $ 不会展开，所以只需处理 '
 */
export function escapePsString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 获取压缩命令（返回 CommandSpec，完全参数化）
 * @param shell Windows 下 PS 执行目标来源
 */
export function getCompressSpec(sourcePath: string, outputPath: string, shell: ShellSpec): CommandSpec {
  if (IS_WIN) {
    const ps = powerShellTarget(shell);
    const src = escapePsString(sourcePath);
    const dst = escapePsString(outputPath);
    return {
      file: ps.file,
      args: [...ps.baseArgs, "-Command", `Compress-Archive -LiteralPath '${src}' -DestinationPath '${dst}' -Force`],
    };
  }
  return { file: "zip", args: ["-r", outputPath, sourcePath] };
}

/**
 * 获取解压命令（返回 CommandSpec）
 * @param shell Windows 下 PS 执行目标来源
 */
export function getExtractSpec(archivePath: string, outputDir: string, shell: ShellSpec): CommandSpec {
  if (IS_WIN) {
    const ps = powerShellTarget(shell);
    const arc = escapePsString(archivePath);
    const out = escapePsString(outputDir);
    return {
      file: ps.file,
      args: [...ps.baseArgs, "-Command", `Expand-Archive -LiteralPath '${arc}' -DestinationPath '${out}' -Force`],
    };
  }
  return { file: "unzip", args: ["-o", archivePath, "-d", outputDir] };
}

export function getSystemInfoSpec(shell: ShellSpec): CommandSpec {
  if (IS_WIN) {
    const ps = powerShellTarget(shell);
    const psScript = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "$os = Get-CimInstance Win32_OperatingSystem;",
      "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1;",
      "$mem = Get-CimInstance Win32_ComputerSystem;",
      '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "$($_.DeviceID) $([math]::Round($_.FreeSpace/1GB,1))/$([math]::Round($_.Size/1GB,1))GB" };',
      'Write-Output "OS: $($os.Caption) ($($os.OSArchitecture))";',
      'Write-Output "CPU: $($cpu.Name) $($cpu.NumberOfCores)C/$($cpu.NumberOfLogicalProcessors)T";',
      'Write-Output "Memory: $([math]::Round($mem.TotalPhysicalMemory/1GB,1))GB total";',
      "Write-Output \"Disk: $($disk -join ', ')\";",
    ].join("\n");
    return { file: ps.file, args: [...ps.baseArgs, "-Command", psScript] };
  }
  // macOS 无 /proc、free；用 sysctl/vm_stat/df。Linux 保留 /proc + free + df。
  const sh = IS_MAC
    ? [
        'echo "OS: $(uname -a)"',
        'echo "CPU: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model 2>/dev/null || echo N/A)"',
        'echo "Memory: $(sysctl -n hw.memsize 2>/dev/null | awk \'{printf "%.1fGB", $1/1024/1024/1024}\' || echo N/A)"',
        'echo "Disk: $(df -h / 2>/dev/null | awk \'NR==2{print $4" free of "$2}\' || echo N/A)"',
      ].join("; ")
    : [
        'echo "OS: $(uname -a)"',
        "echo \"CPU: $(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo N/A)\"",
        "echo \"Memory: $(free -h 2>/dev/null | awk '/^Mem:/{print $2}' || echo N/A)\"",
        'echo "Disk: $(df -h / 2>/dev/null | awk \'NR==2{print $4" free of "$2}\' || echo N/A)"',
      ].join("; ");
  return { file: "/bin/sh", args: ["-c", sh] };
}

/**
 * 获取下载命令（返回 CommandSpec，URL 已在上游用 validateUrl 校验）
 * @param shell Windows 下 PS 执行目标来源
 */
export function getDownloadSpec(url: string, savePath: string, shell: ShellSpec): CommandSpec {
  if (IS_WIN) {
    const ps = powerShellTarget(shell);
    const u = escapePsString(url);
    const p = escapePsString(savePath);
    return {
      file: ps.file,
      args: [
        ...ps.baseArgs,
        "-Command",
        `Invoke-WebRequest -Uri '${u}' -OutFile '${p}' -UseBasicParsing -MaximumRedirection 5`,
      ],
    };
  }
  return { file: "curl", args: ["-fSL", "--max-redirs", "5", "-o", savePath, url] };
}
