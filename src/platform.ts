// src/platform.ts — 跨平台抽象层：shell / 命令 / 搜索引擎选择
import { platform } from "os";

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
  shellCommand?: string;  // 若 useShell=true，这里放最终拼好的 shell 命令
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
    // 使用 PowerShell Get-Process 提供排序 + 过滤；filter 作为参数传入
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "$filter = $args[0];",
      "$top = [int]$args[1];",
      "$procs = if ($filter) { Get-Process | Where-Object { $_.ProcessName -like \"*$filter*\" } } else { Get-Process };",
      "$procs | Sort-Object -Property WorkingSet64 -Descending |",
      "  Select-Object -First $top Id, ProcessName, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, @{N='CPU';E={[math]::Round($_.CPU,1)}} |",
      "  Format-Table -AutoSize | Out-String",
    ].join(" ");
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", script, "--", filter || "", String(top)],
    };
  }
  // Unix: 通过 /bin/sh -c 执行，为了支持 --sort；但 filter 走环境变量避免注入
  if (filter) {
    return {
      file: "/bin/sh",
      args: [
        "-c",
        'ps aux --sort=-%mem 2>/dev/null || ps aux | head -n 1; ps aux 2>/dev/null | grep -i -- "$FILTER" | grep -v grep',
      ],
      useShell: false,
    };
  }
  return {
    file: "/bin/sh",
    args: ["-c", "ps aux --sort=-%mem 2>/dev/null || ps aux"],
  };
}

/**
 * 获取 kill 命令（返回 CommandSpec）
 */
export function getKillSpec(pid?: number, name?: string, force?: boolean): CommandSpec {
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
  return { file: "pkill", args: [sig, name || ""] };
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
      return { file: "/bin/sh", args: ["-c", 'nslookup "$HOST" 2>/dev/null || dig "$HOST"'] };
    default:
      return { file: "/bin/sh", args: ["-c", "ifconfig 2>/dev/null || ip addr"] };
  }
}

/**
 * 获取压缩命令（返回 CommandSpec，完全参数化）
 */
export function getCompressSpec(sourcePath: string, outputPath: string): CommandSpec {
  if (IS_WIN) {
    // 用 -File 风格的 here-script + 参数传递，单引号转义使用 PowerShell 规则（' -> '')
    const psScript =
      "param([string]$Src, [string]$Dst); " +
      "Compress-Archive -Path $Src -DestinationPath $Dst -Force";
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", psScript, "--", sourcePath, outputPath],
    };
  }
  return { file: "zip", args: ["-r", outputPath, sourcePath] };
}

/**
 * 获取解压命令（返回 CommandSpec）
 */
export function getExtractSpec(archivePath: string, outputDir: string): CommandSpec {
  if (IS_WIN) {
    const psScript =
      "param([string]$Arc, [string]$Out); " +
      "Expand-Archive -Path $Arc -DestinationPath $Out -Force";
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", psScript, "--", archivePath, outputDir],
    };
  }
  return { file: "unzip", args: ["-o", archivePath, "-d", outputDir] };
}

/**
 * 获取下载命令（返回 CommandSpec，URL 已在上游用 validateUrl 校验）
 */
export function getDownloadSpec(url: string, savePath: string): CommandSpec {
  if (IS_WIN) {
    const psScript =
      "param([string]$Url, [string]$Out); " +
      "Invoke-WebRequest -Uri $Url -OutFile $Out -UseBasicParsing -MaximumRedirection 5";
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", psScript, "--", url, savePath],
    };
  }
  return { file: "curl", args: ["-fSL", "--max-redirs", "5", "-o", savePath, url] };
}
