/**
 * 系统工具: get_system_info, process_list, kill_process, network_info, environment_vars
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { logger } from "../logger.js";
import { getKillSpec, getNetworkSpec, getProcessListSpec, getSystemInfoSpec } from "../platform.js";
import { ErrorCode, fail, success, type ToolResult } from "../result.js";
import { guardDestructiveAction, isCriticalProcess } from "../safeguard.js";
import { validateHost } from "../security.js";
import { safeExecFile } from "../utils.js";
import { wrapHandler } from "../wrap.js";

const SENSITIVE_ENV_KEYWORDS =
  /(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|PRIVATE_?KEY|CREDENTIAL|ENCRYPTION|PSW|JWT|OAUTH|CERT|LICENSE_KEY|DB_PASS)/i;

export function registerSystemTools(server: McpServer) {
  // ====================================================================
  server.registerTool(
    "get_system_info",
    {
      title: "Get System Info",
      description: "Get detailed system information (OS, CPU, memory, disk, GPU, etc.).",
      inputSchema: z.object({}),
      outputSchema: z.object({ info: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("get_system_info", async () => {
      try {
        const spec = getSystemInfoSpec();
        const result = await safeExecFile(spec.file, spec.args, 30000);
        logger.info("get_system_info", "collected", "system info gathered");
        return success(result.stdout.trim(), { info: result.stdout.trim() });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const ProcessListInput = z.object({
    filter: z.string().optional().describe("Filter processes by name"),
    top: z.number().optional().describe("Show top N processes by memory, default 20"),
  });
  type ProcessListInput = z.infer<typeof ProcessListInput>;

  server.registerTool(
    "process_list",
    {
      title: "List Processes",
      description: "List running processes, optionally filter by name.",
      inputSchema: ProcessListInput,
      outputSchema: z.object({ output: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("process_list", async ({ filter, top }: ProcessListInput) => {
      try {
        const spec = getProcessListSpec(filter, top || 20);
        const result = await safeExecFile(spec.file, spec.args, 10000);
        return success("Running Processes:\n" + result.stdout.trim(), { output: result.stdout.trim() });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const KillProcessInput = z.object({
    pid: z.number().optional().describe("Process ID to kill"),
    name: z.string().optional().describe("Process name to kill"),
    force: z.boolean().optional().describe("Force kill, default false"),
  });
  type KillProcessInput = z.infer<typeof KillProcessInput>;

  server.registerTool(
    "kill_process",
    {
      title: "Kill Process",
      description: "Kill a process by PID or name. Refuses to kill critical system processes.",
      inputSchema: KillProcessInput,
      outputSchema: z.object({ killed: z.boolean(), pid: z.number().optional(), name: z.string().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("kill_process", async ({ pid, name, force }: KillProcessInput) => {
      if (isCriticalProcess(name, pid)) {
        return fail(ErrorCode.PROCESS_PROTECTED, `Cannot kill critical system process: ${name || `PID ${pid}`}`, {
          retryable: false,
          param: name ? "name" : "pid",
        });
      }

      const block = await guardDestructiveAction("kill_process", `终止进程 ${name || pid || "(unknown)"}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: pid ? "pid" : "name" });

      try {
        const spec = getKillSpec(pid, name, force);
        const result = await safeExecFile(spec.file, spec.args, 10000);
        return success(`Killed: ${name || pid}`, { killed: true, pid: pid ?? undefined, name: name ?? undefined });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const NetworkInfoInput = z.object({
    action: z
      .enum(["config", "connections", "ping", "dns"])
      .optional()
      .describe("Action: config, connections, ping, dns. Default: config"),
    target: z.string().optional().describe("Target host for ping/dns"),
  });
  type NetworkInfoInput = z.infer<typeof NetworkInfoInput>;

  server.registerTool(
    "network_info",
    {
      title: "Network Info",
      description: "Get network configuration and connectivity info.",
      inputSchema: NetworkInfoInput,
      outputSchema: z.object({ output: z.string(), action: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("network_info", async ({ action, target }: NetworkInfoInput) => {
      try {
        const act = action || "config";
        if ((act === "ping" || act === "dns") && target) {
          const hostErr = validateHost(target);
          if (hostErr) return fail(ErrorCode.HOST_INVALID, hostErr, { retryable: true, param: "target" });
        }
        const spec = getNetworkSpec(act, target);
        const result = await safeExecFile(spec.file, spec.args, 15000);
        return success(result.stdout.trim(), { output: result.stdout.trim(), action: act });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message, { retryable: true });
      }
    }),
  );

  // ====================================================================
  const EnvironmentVarsInput = z.object({
    action: z.enum(["get", "list"]).describe("get = get one var, list = list all"),
    name: z.string().optional().describe("Variable name (for get)"),
  });
  type EnvironmentVarsInput = z.infer<typeof EnvironmentVarsInput>;

  server.registerTool(
    "environment_vars",
    {
      title: "Environment Variables",
      description: "Get or list environment variables (sensitive keys hidden).",
      inputSchema: EnvironmentVarsInput,
      outputSchema: z.object({ vars: z.record(z.string()).optional(), value: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("environment_vars", async ({ action, name }: EnvironmentVarsInput): Promise<ToolResult> => {
      try {
        if (action === "get" && name) {
          if (SENSITIVE_ENV_KEYWORDS.test(name)) {
            return success(`${name}=*** (hidden)`, { value: "***" });
          }
          const val = process.env[name] || "";
          return success(`${name}=${val}`, { value: val });
        }

        const vars: Record<string, string> = {};
        const entries = Object.entries(process.env)
          .filter(([k]) => k.length > 0)
          .sort(([a], [b]) => a.localeCompare(b));

        for (const [k, v] of entries) {
          vars[k] = SENSITIVE_ENV_KEYWORDS.test(k) ? "***" : String(v ?? "");
        }

        const allLines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
        const maxVars = 100;
        const truncated = allLines.length > maxVars;
        const text = truncated
          ? allLines.slice(0, maxVars).join("\n") + `\n... (${allLines.length - maxVars} more)`
          : allLines.join("\n");
        return success("Environment Variables (sensitive keys hidden):\n" + text, { vars });
      } catch (e: any) {
        return fail(ErrorCode.INTERNAL_ERROR, e.message, { retryable: false });
      }
    }),
  );
}
