// src/platform.ts — 跨平台抽象层：shell / 命令 / 搜索引擎选择
import { platform } from "node:os";
import { sanitizeProcessName } from "./security.js";

export const IS_WIN = platform() === "win32";
export const IS_MAC = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

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

/**
 * 获取进程列表命令（返回 CommandSpec，execFile 执行）
 * Windows: 用 PowerShell Get-Process 并按 WorkingSet 倒序
 * Unix: ps aux --sort=-%mem（若不支持则退化为 ps aux）
 */
export function getProcessListSpec(filter?: string, top = 20): CommandSpec {
  if (IS_WIN) {
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
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", script],
    };
  }
  // Unix: 通过 /bin/sh -c 执行，filter 已通过 sanitizeProcessName 消毒
  if (filter) {
    const safeFilter = sanitizeProcessName(filter);
    if (!safeFilter) {
      // sanitize 后为空，走无 filter 分支
      return { file: "/bin/sh", args: ["-c", `ps aux --sort=-%mem 2>/dev/null || ps aux | head -n ${top}`] };
    }
    return {
      file: "/bin/sh",
      args: [
        "-c",
        `ps aux --sort=-%mem 2>/dev/null || ps aux | head -n 1; ps aux 2>/dev/null | grep -i -- '${safeFilter}' | grep -v grep | head -n ${top}`,
      ],
      useShell: false,
    };
  }
  return {
    file: "/bin/sh",
    args: ["-c", `ps aux --sort=-%mem 2>/dev/null || ps aux | head -n ${top}`],
  };
}

/**
 * 获取 kill 命令（返回 CommandSpec）
 * @throws 当 pid 和 name 都为空时
 */
export function getKillSpec(pid?: number, name?: string, force?: boolean): CommandSpec {
  if (pid == null && !name) {
    throw new Error("getKillSpec requires at least pid or name");
  }
  if (IS_WIN) {
    const args: string[] = [];
    if (pid != null) {
      args.push("/PID", String(pid));
    } else if (name) {
      args.push("/IM", name);
    }
    if (force) args.push("/F");
    return { file: "taskkill", args };
  }
  const sig = force ? "-9" : "-15";
  if (pid != null) {
    return { file: "kill", args: [sig, String(pid)] };
  }
  // pkill 需要精确名（已在上游 sanitize 去掉通配）
  return { file: "pkill", args: [sig, name!] };
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
function escapePsString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 获取压缩命令（返回 CommandSpec，完全参数化）
 */
export function getCompressSpec(sourcePath: string, outputPath: string): CommandSpec {
  if (IS_WIN) {
    const src = escapePsString(sourcePath);
    const dst = escapePsString(outputPath);
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", `Compress-Archive -LiteralPath '${src}' -DestinationPath '${dst}' -Force`],
    };
  }
  return { file: "zip", args: ["-r", outputPath, sourcePath] };
}

/**
 * 获取解压命令（返回 CommandSpec）
 */
export function getExtractSpec(archivePath: string, outputDir: string): CommandSpec {
  if (IS_WIN) {
    const arc = escapePsString(archivePath);
    const out = escapePsString(outputDir);
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${arc}' -DestinationPath '${out}' -Force`],
    };
  }
  return { file: "unzip", args: ["-o", archivePath, "-d", outputDir] };
}

export function getSystemInfoSpec(): CommandSpec {
  if (IS_WIN) {
    const ps = [
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
    return { file: "powershell.exe", args: ["-NoProfile", "-Command", ps] };
  }
  const sh =
    'echo "OS: $(uname -a)"; echo "CPU: $(grep -m1 \'model name\' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs)"; echo "Memory: $(free -h 2>/dev/null | awk \'/^Mem:/{print $2}\' || echo N/A)"; echo "Disk: $(df -h / 2>/dev/null | awk \'NR==2{print $4" free of "$2}\' || echo N/A)";';
  return { file: "/bin/sh", args: ["-c", sh] };
}

/**
 * 获取下载命令（返回 CommandSpec，URL 已在上游用 validateUrl 校验）
 */
export function getDownloadSpec(url: string, savePath: string): CommandSpec {
  if (IS_WIN) {
    const u = escapePsString(url);
    const p = escapePsString(savePath);
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        `Invoke-WebRequest -Uri '${u}' -OutFile '${p}' -UseBasicParsing -MaximumRedirection 5`,
      ],
    };
  }
  return { file: "curl", args: ["-fSL", "--max-redirs", "5", "-o", savePath, url] };
}
