// src/tools/system.ts — 系统工具：get_system_info / process_list / kill_process / network_info / environment_vars
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as os from "os";
import { safeExec, safeExecFile, formatSize, ok, fail } from "../utils.js";
import { IS_WIN } from "../platform.js";
import { getProcessListSpec, getKillSpec, getNetworkSpec } from "../platform.js";
import { sanitizeProcessName } from "../security.js";
import { guardDestructiveAction, isCriticalProcess, getSafetyMode } from "../safeguard.js";
import { logger } from "../logger.js";

// Helper: run a PowerShell Get-CimInstance query and return trimmed stdout
async function psCim(className: string, properties: string[], timeout = 10000): Promise<string> {
  const props = properties.join(", ");
  const cmd = 'powershell -NoProfile -Command "Get-CimInstance -ClassName ' + className + ' | Select-Object ' + props + ' | Format-List"';
  const result = await safeExec(cmd, timeout);
  return result.stdout.trim();
}

// Helper: parse "Key : Value" lines from Format-List output into array of objects
function parseFormatList(raw: string): Array<Record<string, string>> {
  const blocks = raw.split(/\r?\n\r?\n/).filter(b => b.trim().length > 0);
  return blocks.map(block => {
    const obj: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        const val = line.substring(idx + 1).trim();
        obj[key] = val;
      }
    }
    return obj;
  });
}

export function registerSystemTools(server: McpServer) {

  // ===== Tool 13: get_system_info =====
  server.registerTool(
    "get_system_info",
    {
      title: "System Information",
      description: "Get detailed system information (OS, CPU, memory, disk, GPU, etc.) using PowerShell CIM on Windows",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const info: string[] = [];

      try {
        // ---- OS Info ----
        info.push("========== Operating System ==========");
        if (IS_WIN) {
          try {
            const raw = await psCim("Win32_OperatingSystem", ["Caption", "Version", "BuildNumber", "OSArchitecture", "InstallDate"]);
            const parsed = parseFormatList(raw);
            if (parsed.length > 0) {
              const o = parsed[0];
              info.push("OS Name       : " + (o["Caption"] || "N/A"));
              info.push("Version       : " + (o["Version"] || "N/A"));
              info.push("Build         : " + (o["BuildNumber"] || "N/A"));
              info.push("Architecture  : " + (o["OSArchitecture"] || "N/A"));
              info.push("Install Date  : " + (o["InstallDate"] || "N/A"));
            }
          } catch {
            info.push("OS: " + os.type() + " " + os.release() + " " + os.arch());
          }
        } else {
          info.push("OS: " + os.type() + " " + os.release() + " " + os.arch());
          info.push("Platform      : " + os.platform());
        }
        info.push("Hostname      : " + os.hostname());
        info.push("Uptime        : " + Math.floor(os.uptime() / 3600) + "h " + Math.floor((os.uptime() % 3600) / 60) + "m");

        // ---- Computer / Manufacturer ----
        info.push("");
        info.push("========== Computer ==========");
        if (IS_WIN) {
          try {
            const raw = await psCim("Win32_ComputerSystem", ["Name", "Manufacturer", "Model", "TotalPhysicalMemory"]);
            const parsed = parseFormatList(raw);
            if (parsed.length > 0) {
              const o = parsed[0];
              info.push("Device Name   : " + (o["Name"] || "N/A"));
              info.push("Manufacturer  : " + (o["Manufacturer"] || "N/A"));
              info.push("Model         : " + (o["Model"] || "N/A"));
            }
          } catch { /* skip */ }
        } else {
          info.push("Device Name   : " + os.hostname());
        }

        // ---- CPU ----
        info.push("");
        info.push("========== CPU ==========");
        if (IS_WIN) {
          try {
            const raw = await psCim("Win32_Processor", ["Name", "NumberOfCores", "NumberOfLogicalProcessors", "MaxClockSpeed", "CurrentClockSpeed"]);
            const parsed = parseFormatList(raw);
            for (const cpu of parsed) {
              info.push("Model         : " + (cpu["Name"] || "N/A"));
              info.push("Physical Cores: " + (cpu["NumberOfCores"] || "N/A"));
              info.push("Logical Cores : " + (cpu["NumberOfLogicalProcessors"] || "N/A"));
              info.push("Max Clock     : " + (cpu["MaxClockSpeed"] || "N/A") + " MHz");
              if (cpu["CurrentClockSpeed"]) {
                info.push("Current Clock : " + cpu["CurrentClockSpeed"] + " MHz");
              }
            }
          } catch {
            const cpus = os.cpus();
            info.push("Model: " + (cpus[0] ? cpus[0].model : "Unknown"));
            info.push("Logical Cores: " + cpus.length);
          }
        } else {
          const cpus = os.cpus();
          info.push("Model: " + (cpus[0] ? cpus[0].model : "Unknown"));
          info.push("Logical Cores: " + cpus.length);
        }

        // ---- Memory ----
        info.push("");
        info.push("========== Memory (RAM) ==========");
        if (IS_WIN) {
          try {
            const raw = await psCim("Win32_PhysicalMemory", ["Manufacturer", "Capacity", "Speed", "ConfiguredClockSpeed"]);
            const parsed = parseFormatList(raw);
            let totalBytes = 0;
            let stickIndex = 0;
            for (const stick of parsed) {
              stickIndex++;
              const cap = parseInt(stick["Capacity"] || "0", 10);
              totalBytes += cap;
              info.push("Stick #" + stickIndex + "      : " + (stick["Manufacturer"] || "N/A") + " | " + formatSize(cap) + " | " + (stick["Speed"] || "N/A") + " MHz");
            }
            info.push("Total Physical: " + formatSize(totalBytes));
            const freeMem = os.freemem();
            const usedMem = totalBytes - freeMem;
            info.push("Available     : " + formatSize(freeMem));
            info.push("In Use        : " + formatSize(usedMem > 0 ? usedMem : os.totalmem() - freeMem));
          } catch {
            info.push("Total: " + formatSize(os.totalmem()));
            info.push("Free : " + formatSize(os.freemem()));
          }
        } else {
          info.push("Total: " + formatSize(os.totalmem()));
          info.push("Free : " + formatSize(os.freemem()));
        }

        // ---- GPU ----
        info.push("");
        info.push("========== GPU (Graphics) ==========");
        if (IS_WIN) {
          try {
            const raw = await psCim("Win32_VideoController", ["Name", "AdapterRAM", "DriverVersion", "VideoProcessor"]);
            const parsed = parseFormatList(raw);
            let gpuIndex = 0;
            for (const gpu of parsed) {
              gpuIndex++;
              const vram = parseInt(gpu["AdapterRAM"] || "0", 10);
              info.push("GPU #" + gpuIndex + "        : " + (gpu["Name"] || "N/A"));
              if (vram > 0) {
                info.push("  VRAM        : " + formatSize(vram));
              }
              info.push("  Driver      : " + (gpu["DriverVersion"] || "N/A"));
            }
          } catch {
            info.push("(Unable to query GPU info)");
          }
        } else {
          try {
            const lspci = await safeExec("lspci | grep -i vga 2>/dev/null || echo '(No GPU info available)'", 5000);
            info.push(lspci.stdout.trim());
          } catch {
            info.push("(GPU query not available on this platform)");
          }
        }

        // ---- Disks ----
        info.push("");
        info.push("========== Disks ==========");
        if (IS_WIN) {
          try {
            const raw = await psCim("Win32_LogicalDisk", ["DeviceID", "Size", "FreeSpace", "FileSystem", "VolumeName"]);
            const parsed = parseFormatList(raw);
            let totalSize = 0;
            let totalFree = 0;
            for (const disk of parsed) {
              const size = parseInt(disk["Size"] || "0", 10);
              const free = parseInt(disk["FreeSpace"] || "0", 10);
              if (size > 0) {
                totalSize += size;
                totalFree += free;
                const used = size - free;
                const pct = ((used / size) * 100).toFixed(1);
                const label = disk["VolumeName"] ? " (" + disk["VolumeName"] + ")" : "";
                info.push(disk["DeviceID"] + label + "  " + disk["FileSystem"] + "  Total: " + formatSize(size) + "  Free: " + formatSize(free) + "  Used: " + pct + "%");
              }
            }
            info.push("---");
            info.push("All Disks Total: " + formatSize(totalSize) + "  Free: " + formatSize(totalFree));
          } catch {
            info.push("(Unable to query disk info)");
          }
        } else {
          try {
            const dfResult = await safeExec("df -h", 5000);
            info.push(dfResult.stdout.trim());
          } catch {
            info.push("(Unable to query disk info)");
          }
        }

        // ---- BIOS (Windows only) ----
        if (IS_WIN) {
          info.push("");
          info.push("========== BIOS ==========");
          try {
            const raw = await psCim("Win32_BIOS", ["Manufacturer", "SMBIOSBIOSVersion", "ReleaseDate"]);
            const parsed = parseFormatList(raw);
            if (parsed.length > 0) {
              const b = parsed[0];
              info.push("Manufacturer  : " + (b["Manufacturer"] || "N/A"));
              info.push("BIOS Version  : " + (b["SMBIOSBIOSVersion"] || "N/A"));
              info.push("Release Date  : " + (b["ReleaseDate"] || "N/A"));
            }
          } catch { /* skip */ }
        }

        // ---- Network ----
        info.push("");
        info.push("========== Network Interfaces (IPv4) ==========");
        const nets = os.networkInterfaces();
        for (const [name, addrs] of Object.entries(nets)) {
          if (addrs) {
            for (const addr of addrs) {
              if (addr.family === "IPv4") {
                info.push("  " + name + ": " + addr.address + (addr.internal ? " (loopback)" : ""));
              }
            }
          }
        }

        logger.info("get_system_info", "collected", "system info gathered");
        return ok(info.join("\n"));
      } catch (e: any) {
        return fail("System info failed: " + e.message);
      }
    }
  );

  // ===== Tool 14: process_list =====
  server.registerTool(
    "process_list",
    {
      title: "Process List",
      description: "List running processes, optionally filter by name",
      inputSchema: {
        filter: z.string().optional().describe("Filter processes by name"),
        top: z.number().optional().describe("Show top N processes by memory, default 20"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ filter, top }) => {
      try {
        const spec = getProcessListSpec(filter, top || 20);
        const result = await safeExecFile(spec.file, spec.args, 10000);
        let lines = result.stdout.trim().split("\n");
        const maxLines = top || 20;
        if (lines.length > maxLines) {
          lines = lines.slice(0, maxLines);
          lines.push("... (" + maxLines + " shown, more available)");
        }
        return ok("Running Processes:\n" + lines.join("\n"));
      } catch (e: any) {
        return fail("Process list failed: " + e.message);
      }
    }
  );

  // ===== Tool 15: kill_process =====
  server.registerTool(
    "kill_process",
    {
      title: "Kill Process",
      description: "Kill a process by PID or name",
      inputSchema: {
        pid: z.number().optional().describe("Process ID to kill"),
        name: z.string().optional().describe("Process name to kill"),
        force: z.boolean().optional().describe("Force kill, default false"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ pid, name, force }) => {
      try {
        if (!pid && !name) {
          return fail("Provide either pid or name");
        }
        const safeName = name ? sanitizeProcessName(name) : undefined;

        // 硬性底线：关键进程黑名单（所有模式生效）
        if (isCriticalProcess(safeName)) {
          logger.warn("kill_process", "critical-blocked", `Protected system process: ${safeName}`);
          return fail(`[SAFETY] Cannot kill critical system process: ${safeName}\nThis process is essential for system stability and is protected in all safety modes.`);
        }

        // 安全锁：杀进程需要确认
        const desc = pid
          ? `终止进程 PID=${pid}${force ? " (强制)" : ""}`
          : `终止进程 "${safeName}"${force ? " (强制)" : ""}`;
        const blocked = await guardDestructiveAction("kill_process", desc);
        if (blocked) return fail(blocked);

        const spec = getKillSpec(pid, safeName, force);
        logger.warn("kill_process", "killing", `${spec.file} ${spec.args.join(" ")}`);
        const result = await safeExecFile(spec.file, spec.args, 10000);
        return ok(result.stdout.trim() || result.stderr.trim() || "Process terminated");
      } catch (e: any) {
        return fail("Kill failed: " + e.message);
      }
    }
  );

  // ===== Tool 16: network_info =====
  server.registerTool(
    "network_info",
    {
      title: "Network Info",
      description: "Get network configuration and connectivity info",
      inputSchema: {
        action: z.enum(["config", "connections", "ping", "dns"]).optional()
          .describe("Action: config(ipconfig), connections(netstat), ping, dns. Default: config"),
        target: z.string().optional().describe("Target host for ping/dns"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ action, target }) => {
      try {
        const act = action || "config";
        const spec = getNetworkSpec(act, target);
        const result = await safeExecFile(spec.file, spec.args, 15000);
        return ok(result.stdout.trim());
      } catch (e: any) {
        return fail("Network info failed: " + e.message);
      }
    }
  );

  // ===== Tool 17: environment_vars =====
  server.registerTool(
    "environment_vars",
    {
      title: "Environment Variables",
      description: "Get or set environment variables",
      inputSchema: {
        action: z.enum(["get", "list"]).describe("get = get one var, list = list all"),
        name: z.string().optional().describe("Variable name (for get)"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ action, name }) => {
      try {
        if (action === "get") {
          if (!name) return fail("Provide variable name");
          const val = process.env[name];
          return ok(name + "=" + (val || "(not set)"));
        } else {
          const vars = Object.entries(process.env)
            .filter(([k]) => k.length > 0)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => k + "=" + v)
            .join("\n");
          return ok("Environment Variables:\n" + vars);
        }
      } catch (e: any) {
        return fail("Env failed: " + e.message);
      }
    }
  );
}
