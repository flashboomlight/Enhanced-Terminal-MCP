# Enhanced Terminal MCP v3.0 全面升级实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Enhanced Terminal MCP 从 v2.0 全面升级到 v3.0，涵盖安全加固、MCP 协议新特性适配、跨平台兼容、结构化输出、性能优化等 12 个方向。

**Architecture:** 保持现有模块化架构（index.ts + tools/*.ts + utils.ts），在此基础上新增安全层（security.ts）、平台抽象层（platform.ts）、日志系统（logger.ts）。工具注册层面增加 annotations/outputSchema 支持。

**Tech Stack:** TypeScript 5.x, @modelcontextprotocol/sdk 1.26.x, zod 3.x, Node.js 18+

---

## File Structure

### 新增文件
- `src/security.ts` — 安全校验：路径穿越检测、命令注入防护、危险路径白名单
- `src/platform.ts` — 跨平台抽象：shell/命令/搜索引擎选择
- `src/logger.ts` — 结构化日志系统

### 修改文件
- `src/utils.ts` — 重构 safeExec 支持跨平台 + 安全校验
- `src/index.ts` — 注册 Resources/Prompts，版本号升到 3.0.0
- `src/tools/command.ts` — 添加 annotations + 安全校验 + 输入消毒
- `src/tools/files.ts` — 添加 annotations + outputSchema + 异步IO + 路径安全
- `src/tools/search.ts` — 添加 annotations + 跨平台搜索 + 结构化输出
- `src/tools/manage.ts` — 添加 annotations + 路径安全 + 确认机制
- `src/tools/system.ts` — 添加 annotations + 跨平台 + 结构化输出
- `src/tools/archive.ts` — 添加 annotations + 跨平台 + 安全校验
- `package.json` — 版本号 3.0.0

---

## Task 1: 安全基础层 — security.ts

**Files:**
- Create: `src/security.ts`

- [ ] **Step 1: 创建安全模块**

```typescript
// src/security.ts
import * as path from "path";
import { platform } from "os";

// 禁止操作的系统关键路径
const FORBIDDEN_PATHS_WIN = [
  "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)",
  "C:\\ProgramData", "C:\\$Recycle.Bin", "C:\\System Volume Information",
];
const FORBIDDEN_PATHS_UNIX = [
  "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/boot",
  "/etc", "/proc", "/sys", "/dev",
];

export function getForbiddenPaths(): string[] {
  return platform() === "win32" ? FORBIDDEN_PATHS_WIN : FORBIDDEN_PATHS_UNIX;
}

/**
 * 检测路径穿越攻击
 * 将路径规范化后检查是否包含 .. 或尝试逃出基准目录
 */
export function isPathTraversal(inputPath: string): boolean {
  const normalized = path.resolve(inputPath);
  // 检查是否有明显的穿越模式
  if (inputPath.includes("..")) {
    return true;
  }
  return false;
}

/**
 * 检查路径是否在禁止列表中
 */
export function isForbiddenPath(targetPath: string): boolean {
  const normalized = path.resolve(targetPath).toLowerCase();
  const forbidden = getForbiddenPaths();
  return forbidden.some(fp => normalized.toLowerCase().startsWith(fp.toLowerCase()));
}

/**
 * 校验路径安全性，返回错误消息或 null
 */
export function validatePath(targetPath: string, operation: string): string | null {
  if (!targetPath || targetPath.trim().length === 0) {
    return "Path cannot be empty";
  }
  if (isPathTraversal(targetPath)) {
    return `Path traversal detected in ${operation}: ${targetPath}`;
  }
  if (isForbiddenPath(targetPath)) {
    return `Operation '${operation}' blocked: path is in protected system directory: ${targetPath}`;
  }
  return null;
}

/**
 * 对 shell 命令参数做基本的危险字符检测
 */
const DANGEROUS_PATTERNS = [
  /;\s*rm\s/i, /;\s*del\s/i, /;\s*format\s/i,
  /\|\s*rm\s/i, /&&\s*rm\s/i,
  />\s*\/dev\/sd/i, // dd-style 覆写
  /mkfs\./i,
  /:(){ :\|:& };:/,  // fork bomb
];

export function hasDangerousPattern(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd));
}

/**
 * 对进程名/PID 做输入消毒
 */
export function sanitizeProcessName(name: string): string {
  // 只保留字母数字点和短横线
  return name.replace(/[^a-zA-Z0-9.\-_*]/g, "");
}
```

---

## Task 2: 跨平台抽象层 — platform.ts

**Files:**
- Create: `src/platform.ts`

- [ ] **Step 1: 创建平台抽象模块**

```typescript
// src/platform.ts
import { platform } from "os";

export const IS_WIN = platform() === "win32";
export const IS_MAC = platform() === "darwin";
export const IS_LINUX = platform() === "linux";

/**
 * 获取当前平台的默认 shell
 */
export function getShell(): string {
  if (IS_WIN) return "cmd.exe";
  return process.env.SHELL || "/bin/sh";
}

/**
 * 构建平台适配的完整命令
 */
export function wrapCommand(cmd: string): string {
  if (IS_WIN) {
    return `chcp 65001 >nul & ${cmd}`;
  }
  return cmd;
}

/**
 * 获取进程列表命令
 */
export function getProcessListCmd(filter?: string): string {
  if (IS_WIN) {
    if (filter) {
      return `tasklist /FO CSV /NH /FI "IMAGENAME eq *${filter}*"`;
    }
    return "tasklist /FO CSV /NH";
  }
  if (filter) {
    return `ps aux | grep -i "${filter}" | grep -v grep`;
  }
  return "ps aux --sort=-%mem";
}

/**
 * 获取 kill 命令
 */
export function getKillCmd(pid?: number, name?: string, force?: boolean): string {
  if (IS_WIN) {
    const f = force ? " /F" : "";
    if (pid) return `taskkill /PID ${pid}${f}`;
    return `taskkill /IM ${name}${f}`;
  }
  const sig = force ? "-9" : "-15";
  if (pid) return `kill ${sig} ${pid}`;
  return `pkill ${sig} "${name}"`;
}

/**
 * 获取网络命令
 */
export function getNetworkCmd(action: string, target?: string): string {
  if (IS_WIN) {
    switch (action) {
      case "config": return "ipconfig /all";
      case "connections": return "netstat -an";
      case "ping": return `ping -n 4 ${target || "127.0.0.1"}`;
      case "dns": return `nslookup ${target || "localhost"}`;
      default: return "ipconfig";
    }
  }
  switch (action) {
    case "config": return "ifconfig 2>/dev/null || ip addr";
    case "connections": return "netstat -an 2>/dev/null || ss -an";
    case "ping": return `ping -c 4 ${target || "127.0.0.1"}`;
    case "dns": return `nslookup ${target || "localhost"} 2>/dev/null || dig ${target || "localhost"}`;
    default: return "ifconfig 2>/dev/null || ip addr";
  }
}

/**
 * 获取压缩命令（跨平台）
 */
export function getCompressCmd(sourcePath: string, outputPath: string): { cmd: string; useExecFile: boolean; args?: string[] } {
  if (IS_WIN) {
    const psCmd = `Compress-Archive -Path '${sourcePath.replace(/'/g, "''")}' -DestinationPath '${outputPath.replace(/'/g, "''")}' -Force`;
    return { cmd: "powershell.exe", useExecFile: true, args: ["-NoProfile", "-Command", psCmd] };
  }
  return { cmd: `zip -r "${outputPath}" "${sourcePath}"`, useExecFile: false };
}

/**
 * 获取解压命令
 */
export function getExtractCmd(archivePath: string, outputDir: string): { cmd: string; useExecFile: boolean; args?: string[] } {
  if (IS_WIN) {
    const psCmd = `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${outputDir.replace(/'/g, "''")}' -Force`;
    return { cmd: "powershell.exe", useExecFile: true, args: ["-NoProfile", "-Command", psCmd] };
  }
  return { cmd: `unzip -o "${archivePath}" -d "${outputDir}"`, useExecFile: false };
}

/**
 * 获取下载命令
 */
export function getDownloadCmd(url: string, savePath: string): { cmd: string; useExecFile: boolean; args?: string[] } {
  if (IS_WIN) {
    const psCmd = `Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -OutFile '${savePath.replace(/'/g, "''")}' -UseBasicParsing`;
    return { cmd: "powershell.exe", useExecFile: true, args: ["-NoProfile", "-Command", psCmd] };
  }
  return { cmd: `curl -fSL -o "${savePath}" "${url}"`, useExecFile: false };
}
```

---

## Task 3: 日志系统 — logger.ts

**Files:**
- Create: `src/logger.ts`

- [ ] **Step 1: 创建日志模块**

```typescript
// src/logger.ts

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

const currentLevel: LogLevel = (process.env.MCP_LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function formatMsg(level: LogLevel, tool: string, action: string, detail?: string): string {
  const ts = new Date().toISOString();
  const base = `[${ts}] [${level.toUpperCase()}] [${tool}] ${action}`;
  return detail ? `${base}: ${detail}` : base;
}

export const logger = {
  debug(tool: string, action: string, detail?: string) {
    if (shouldLog("debug")) console.error(formatMsg("debug", tool, action, detail));
  },
  info(tool: string, action: string, detail?: string) {
    if (shouldLog("info")) console.error(formatMsg("info", tool, action, detail));
  },
  warn(tool: string, action: string, detail?: string) {
    if (shouldLog("warn")) console.error(formatMsg("warn", tool, action, detail));
  },
  error(tool: string, action: string, detail?: string) {
    if (shouldLog("error")) console.error(formatMsg("error", tool, action, detail));
  },
};
```

---

## Task 4: 重构 utils.ts — 跨平台 safeExec

**Files:**
- Modify: `src/utils.ts`

- [ ] **Step 1: 重写 utils.ts**

```typescript
// src/utils.ts
import { exec, execFile } from "child_process";
import { getShell, wrapCommand, IS_WIN } from "./platform.js";

export function safeExec(
  cmd: string,
  timeout = 30000,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const fullCmd = wrapCommand(cmd);
    const proc = exec(fullCmd, {
      cwd: cwd || undefined,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
      timeout: timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: getShell(),
      encoding: "buffer",
    } as any, (error: any, stdoutBuf: any, stderrBuf: any) => {
      const stdout = smartDecode(stdoutBuf);
      const stderr = smartDecode(stderrBuf);
      if (error) {
        if (error.killed) {
          reject(new Error(`Timeout (${timeout}ms)\n[CMD]: ${cmd}`));
        } else if (!stdout && !stderr) {
          reject(new Error(`Exit code ${error.code}\n[CMD]: ${cmd}\n[DETAIL]: ${error.message}`));
        } else {
          resolve({ stdout, stderr: stderr ? stderr + "\n[EXIT CODE] " + error.code : "" });
        }
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * 安全执行命令 — 使用 execFile 避免 shell 注入（用于参数化命令）
 */
export function safeExecFile(
  file: string,
  args: string[],
  timeout = 30000,
  cwd?: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: cwd || undefined,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && !stdout && !stderr) {
        reject(error);
      } else {
        resolve({
          stdout: (stdout || "").toString(),
          stderr: (stderr || "").toString(),
        });
      }
    });
  });
}

function smartDecode(buf: Buffer | null): string {
  if (!buf || buf.length === 0) return "";
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buf);
  if (!utf8.includes("\ufffd")) return utf8;
  try {
    return new TextDecoder("gbk", { fatal: false }).decode(buf);
  } catch {
    return utf8;
  }
}

export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return size.toFixed(2) + " " + units[i];
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function fail(text: string) {
  return { content: [{ type: "text" as const, text: "[ERROR] " + text }], isError: true as const };
}

/**
 * 返回结构化输出（同时包含 content 和 structuredContent）
 */
export function okStructured(text: string, data: Record<string, any>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data,
  };
}
```

---

## Task 5: 升级 command.ts — Annotations + 安全校验

**Files:**
- Modify: `src/tools/command.ts`

- [ ] **Step 1: 重写 command.ts**

```typescript
// src/tools/command.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeExec, ok, fail } from "../utils.js";
import { hasDangerousPattern } from "../security.js";
import { logger } from "../logger.js";

export function registerCommandTools(server: McpServer) {

  // ===== Tool 1: execute_command =====
  server.tool(
    "execute_command",
    {
      title: "Execute Command",
      description: "Execute a terminal/shell command and return the output",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      command: z.string().describe("The command to execute"),
      cwd: z.string().optional().describe("Working directory (optional)"),
      timeout: z.number().optional().describe("Timeout in ms, default 30000"),
    },
    async ({ command, cwd, timeout }) => {
      logger.info("execute_command", "exec", command);
      if (hasDangerousPattern(command)) {
        logger.warn("execute_command", "blocked", `Dangerous pattern detected: ${command}`);
        return fail("Command blocked: contains potentially dangerous pattern. Please review and try a safer command.");
      }
      try {
        const result = await safeExec(command, timeout || 30000, cwd);
        const parts: string[] = [];
        parts.push("$ " + command);
        if (result.stdout) parts.push(result.stdout.trim());
        if (result.stderr) parts.push("[STDERR]\n" + result.stderr.trim());
        return ok(parts.join("\n"));
      } catch (e: any) {
        logger.error("execute_command", "failed", e.message);
        return fail("Command failed: " + e.message);
      }
    }
  );

  // ===== Tool 2: batch_execute =====
  server.tool(
    "batch_execute",
    {
      title: "Batch Execute Commands",
      description: "Execute multiple commands sequentially, stop on error if needed",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    {
      commands: z.array(z.string()).describe("Array of commands to execute"),
      cwd: z.string().optional().describe("Working directory"),
      stop_on_error: z.boolean().optional().describe("Stop if a command fails, default true"),
    },
    async ({ commands, cwd, stop_on_error }) => {
      const stopOnErr = stop_on_error !== false;
      const results: string[] = [];
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        logger.info("batch_execute", `step ${i + 1}/${commands.length}`, cmd);
        if (hasDangerousPattern(cmd)) {
          results.push(`--- [${i + 1}/${commands.length}] $ ${cmd} ---`);
          results.push("[BLOCKED] Dangerous pattern detected");
          if (stopOnErr) { results.push("(Stopped due to blocked command)"); break; }
          continue;
        }
        results.push(`--- [${i + 1}/${commands.length}] $ ${cmd} ---`);
        try {
          const r = await safeExec(cmd, 30000, cwd);
          if (r.stdout) results.push(r.stdout.trim());
          if (r.stderr) results.push("[STDERR] " + r.stderr.trim());
        } catch (e: any) {
          results.push("[FAILED] " + e.message);
          if (stopOnErr) {
            results.push("(Stopped due to error)");
            break;
          }
        }
      }
      return ok(results.join("\n"));
    }
  );

  // ===== Tool 3: watch_command =====
  server.tool(
    "watch_command",
    {
      title: "Watch Command",
      description: "Execute a command and capture output for a limited duration",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    {
      command: z.string().describe("The command to run"),
      duration: z.number().optional().describe("Max duration in ms, default 5000"),
      cwd: z.string().optional().describe("Working directory"),
    },
    async ({ command, duration, cwd }) => {
      logger.info("watch_command", "watch", command);
      try {
        const ms = Math.min(duration || 5000, 30000);
        const result = await safeExec(command, ms, cwd);
        const parts = ["$ " + command, `(captured for up to ${ms}ms)`];
        if (result.stdout) parts.push(result.stdout.trim());
        if (result.stderr) parts.push("[STDERR]\n" + result.stderr.trim());
        return ok(parts.join("\n"));
      } catch (e: any) {
        if (e.killed) {
          return ok("$ " + command + "\n(timed out)\n" + (e.stdout || ""));
        }
        return fail("Watch failed: " + e.message);
      }
    }
  );
}
```

---

## Task 6: 升级 files.ts — Annotations + 异步IO + 路径安全 + 结构化输出

**Files:**
- Modify: `src/tools/files.ts`

- [ ] **Step 1: 重写 files.ts**

```typescript
// src/tools/files.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { formatSize, ok, fail, okStructured } from "../utils.js";
import { validatePath } from "../security.js";
import { logger } from "../logger.js";

export function registerFileTools(server: McpServer) {

  // ===== Tool 4: read_file =====
  server.tool(
    "read_file",
    {
      title: "Read File",
      description: "Read the contents of a file",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      file_path: z.string().describe("Absolute path to the file"),
      encoding: z.string().optional().describe("Encoding, default utf-8"),
      lines: z.number().optional().describe("Max lines to read, 0 = all"),
    },
    async ({ file_path, encoding, lines }) => {
      const pathErr = validatePath(file_path, "read_file");
      if (pathErr) return fail(pathErr);
      try {
        const enc = (encoding || "utf-8") as BufferEncoding;
        let content = await fs.readFile(file_path, enc);
        if (lines && lines > 0) {
          content = content.split("\n").slice(0, lines).join("\n");
        }
        logger.info("read_file", "read", file_path);
        return ok(content);
      } catch (e: any) {
        logger.error("read_file", "failed", e.message);
        return fail("Read failed: " + e.message);
      }
    }
  );

  // ===== Tool 5: write_file =====
  server.tool(
    "write_file",
    {
      title: "Write File",
      description: "Write content to a file (creates parent dirs if needed)",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    {
      file_path: z.string().describe("Absolute path to the file"),
      content: z.string().describe("Content to write"),
      append: z.boolean().optional().describe("Append instead of overwrite, default false"),
    },
    async ({ file_path, content, append }) => {
      const pathErr = validatePath(file_path, "write_file");
      if (pathErr) return fail(pathErr);
      try {
        const dir = path.dirname(file_path);
        await fs.mkdir(dir, { recursive: true });
        if (append) {
          await fs.appendFile(file_path, content, "utf-8");
          logger.info("write_file", "appended", file_path);
          return ok("Appended to: " + file_path);
        } else {
          await fs.writeFile(file_path, content, "utf-8");
          logger.info("write_file", "written", file_path);
          return ok("Written to: " + file_path);
        }
      } catch (e: any) {
        logger.error("write_file", "failed", e.message);
        return fail("Write failed: " + e.message);
      }
    }
  );

  // ===== Tool 6: list_directory =====
  server.tool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path with details",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      dir_path: z.string().describe("Absolute path to directory"),
      recursive: z.boolean().optional().describe("List recursively, default false"),
      max_depth: z.number().optional().describe("Max depth for recursive, default 3"),
    },
    async ({ dir_path, recursive, max_depth }) => {
      const pathErr = validatePath(dir_path, "list_directory");
      if (pathErr) return fail(pathErr);
      try {
        const maxD = max_depth || 3;
        const lines: string[] = [];
        lines.push("Directory: " + dir_path + "\n");

        async function listDir(p: string, depth: number) {
          const entries = await fs.readdir(p, { withFileTypes: true });
          const indent = "  ".repeat(depth);
          for (const entry of entries) {
            const full = path.join(p, entry.name);
            if (entry.isDirectory()) {
              lines.push(indent + "[DIR]  " + entry.name + "/");
              if (recursive && depth < maxD) {
                await listDir(full, depth + 1);
              }
            } else {
              try {
                const stat = await fs.stat(full);
                lines.push(indent + "[FILE] " + entry.name + "  (" + formatSize(stat.size) + ")");
              } catch {
                lines.push(indent + "[FILE] " + entry.name);
              }
            }
          }
        }

        await listDir(dir_path, 0);
        logger.info("list_directory", "listed", dir_path);
        return ok(lines.join("\n"));
      } catch (e: any) {
        return fail("List failed: " + e.message);
      }
    }
  );

  // ===== Tool 7: file_info =====
  server.tool(
    "file_info",
    {
      title: "File Info",
      description: "Get detailed information about a file or directory",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      target_path: z.string().describe("Absolute path to file or directory"),
    },
    async ({ target_path }) => {
      const pathErr = validatePath(target_path, "file_info");
      if (pathErr) return fail(pathErr);
      try {
        const stat = await fs.stat(target_path);
        const fileType = stat.isDirectory() ? "Directory" : stat.isFile() ? "File" : "Other";
        const data = {
          path: target_path,
          type: fileType,
          size: stat.size,
          sizeFormatted: formatSize(stat.size),
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
          permissions: "0" + (stat.mode & 0o777).toString(8),
        };
        const info = [
          "Path: " + data.path,
          "Type: " + data.type,
          "Size: " + data.sizeFormatted,
          "Created: " + data.created,
          "Modified: " + data.modified,
          "Accessed: " + data.accessed,
          "Permissions: " + data.permissions,
        ];
        logger.info("file_info", "info", target_path);
        return okStructured(info.join("\n"), data);
      } catch (e: any) {
        return fail("Info failed: " + e.message);
      }
    }
  );

  // ===== Tool 8: make_directory =====
  server.tool(
    "make_directory",
    {
      title: "Make Directory",
      description: "Create a directory (including parent directories)",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    {
      dir_path: z.string().describe("Absolute path of directory to create"),
    },
    async ({ dir_path }) => {
      const pathErr = validatePath(dir_path, "make_directory");
      if (pathErr) return fail(pathErr);
      try {
        await fs.mkdir(dir_path, { recursive: true });
        logger.info("make_directory", "created", dir_path);
        return ok("Directory created: " + dir_path);
      } catch (e: any) {
        return fail("Mkdir failed: " + e.message);
      }
    }
  );
}
```

---

## Task 7: 升级 manage.ts — Annotations + 路径安全

**Files:**
- Modify: `src/tools/manage.ts`

- [ ] **Step 1: 重写 manage.ts**

```typescript
// src/tools/manage.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { ok, fail } from "../utils.js";
import { validatePath } from "../security.js";
import { logger } from "../logger.js";

export function registerManageTools(server: McpServer) {

  // ===== Tool 11: copy_move =====
  server.tool(
    "copy_move",
    {
      title: "Copy or Move",
      description: "Copy or move a file/directory to a new location",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    {
      source: z.string().describe("Source path"),
      destination: z.string().describe("Destination path"),
      operation: z.enum(["copy", "move"]).describe("Operation: copy or move"),
    },
    async ({ source, destination, operation }) => {
      const srcErr = validatePath(source, "copy_move:source");
      if (srcErr) return fail(srcErr);
      const dstErr = validatePath(destination, "copy_move:destination");
      if (dstErr) return fail(dstErr);
      try {
        const destDir = path.dirname(destination);
        await fs.mkdir(destDir, { recursive: true });

        if (operation === "copy") {
          const stat = await fs.stat(source);
          if (stat.isDirectory()) {
            await fs.cp(source, destination, { recursive: true });
          } else {
            await fs.copyFile(source, destination);
          }
          logger.info("copy_move", "copied", `${source} -> ${destination}`);
          return ok("Copied: " + source + " -> " + destination);
        } else {
          await fs.rename(source, destination);
          logger.info("copy_move", "moved", `${source} -> ${destination}`);
          return ok("Moved: " + source + " -> " + destination);
        }
      } catch (e: any) {
        logger.error("copy_move", "failed", e.message);
        return fail("Operation failed: " + e.message);
      }
    }
  );

  // ===== Tool 12: delete_path =====
  server.tool(
    "delete_path",
    {
      title: "Delete Path",
      description: "Delete a file or directory (use with caution!)",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    {
      target_path: z.string().describe("Path to delete"),
      recursive: z.boolean().optional().describe("Delete directory recursively, default false"),
    },
    async ({ target_path, recursive }) => {
      const pathErr = validatePath(target_path, "delete_path");
      if (pathErr) return fail(pathErr);
      try {
        const stat = await fs.stat(target_path);
        if (stat.isDirectory()) {
          if (recursive) {
            await fs.rm(target_path, { recursive: true, force: true });
          } else {
            await fs.rmdir(target_path);
          }
          logger.warn("delete_path", "deleted directory", target_path);
          return ok("Directory deleted: " + target_path);
        } else {
          await fs.unlink(target_path);
          logger.warn("delete_path", "deleted file", target_path);
          return ok("File deleted: " + target_path);
        }
      } catch (e: any) {
        return fail("Delete failed: " + e.message);
      }
    }
  );
}
```

---

## Task 8: 升级 system.ts — Annotations + 跨平台 + 结构化输出

**Files:**
- Modify: `src/tools/system.ts`

- [ ] **Step 1: 重写 system.ts**

在原有基础上添加 annotations，使用 platform.ts 的跨平台命令，为 process_list/kill_process/network_info 添加注解。保留原有的 PowerShell CIM 查询逻辑但使其在非 Windows 下优雅降级。

（此文件较大，关键修改点是：每个 server.tool() 调用的第二参数改为对象形式 `{ title, description, annotations }`）

---

## Task 9: 升级 search.ts — Annotations + 跨平台搜索

**Files:**
- Modify: `src/tools/search.ts`

- [ ] **Step 1: 添加跨平台搜索支持**

关键修改：
- Everything 搜索保留 Windows 专属，但在 Linux/macOS 上使用 `find` + `locate` 兜底
- 所有工具添加 annotations
- grep_content 添加 annotations

---

## Task 10: 升级 archive.ts — Annotations + 跨平台

**Files:**
- Modify: `src/tools/archive.ts`

- [ ] **Step 1: 使用 platform.ts 重写归档工具**

关键修改：
- 使用 `getCompressCmd()`/`getExtractCmd()`/`getDownloadCmd()` 跨平台
- 所有工具添加 annotations

---

## Task 11: 升级 index.ts — 版本号 + Resources + Prompts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 升级入口文件**

```typescript
#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";
import * as os from "os";

import { registerCommandTools } from "./tools/command.js";
import { registerFileTools } from "./tools/files.js";
import { registerSearchTools } from "./tools/search.js";
import { registerManageTools } from "./tools/manage.js";
import { registerSystemTools } from "./tools/system.js";
import { registerArchiveTools } from "./tools/archive.js";
import { logger } from "./logger.js";

const server = new McpServer({
  name: "enhanced-terminal-mcp",
  version: "3.0.0",
});

// Register all tool groups
registerCommandTools(server);
registerFileTools(server);
registerSearchTools(server);
registerManageTools(server);
registerSystemTools(server);
registerArchiveTools(server);

// ===== Resources: 暴露文件系统资源 =====
server.resource(
  "file",
  new ResourceTemplate("file://{path}", { list: undefined }),
  async (uri, { path: filePath }) => {
    try {
      const content = await fs.readFile(filePath as string, "utf-8");
      return {
        contents: [{
          uri: uri.href,
          mimeType: "text/plain",
          text: content,
        }],
      };
    } catch (e: any) {
      throw new Error("Cannot read resource: " + e.message);
    }
  }
);

// ===== Prompts: 预定义工作流 =====
server.prompt(
  "diagnose-system",
  "Run a comprehensive system diagnostics checklist",
  async () => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Please run a comprehensive system diagnostics by executing these steps:
1. Get system info (OS, CPU, memory, disk, GPU)
2. List top 10 processes by memory usage
3. Check network configuration
4. Check disk usage on all drives
Summarize any warnings or issues found.`,
      },
    }],
  })
);

server.prompt(
  "project-overview",
  "Analyze the current working directory as a project",
  { directory: z.string().optional().describe("Project directory path") },
  async ({ directory }) => ({
    messages: [{
      role: "user" as const,
      content: {
        type: "text" as const,
        text: `Please analyze the project at "${directory || process.cwd()}":
1. List the directory structure (2 levels deep)
2. Look for package.json, Cargo.toml, pyproject.toml or similar project files
3. Identify the tech stack and key dependencies
4. Summarize the project structure and purpose`,
      },
    }],
  })
);

import { z } from "zod";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server", "started", "Enhanced Terminal MCP v3.0.0 - 21 tools, 1 resource, 2 prompts");
}

main().catch((err) => {
  console.error("[Enhanced Terminal MCP] Fatal error:", err);
  process.exit(1);
});
```

---

## Task 12: 升级 package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 更新版本号和元信息**

version: "2.0.0" -> "3.0.0"
