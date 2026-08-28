/**
 * 系统工具: get_system_info, process_list, kill_process, network_info, environment_vars
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { boundedString, finiteInt, type RequestContext } from "../hardening-contract.js";
import { logger } from "../logger.js";
import { validateTarget } from "../network-policy.js";
import { assertIntRange, assertStringBounded, SEARCH_BUDGET } from "../partial-result.js";
import { getNetworkSpec, getProcessListSpec, getSystemInfoSpec } from "../platform.js";
import {
  defaultProcessIdentityProvider,
  isExactProcessNameValid,
  isProcessIdentityValid,
  isProtectedInput,
  isProtectedProcessIdentity,
  isToolError,
  type ProcessIdentity,
  type ProcessIdentityProvider,
  parseKillTarget,
} from "../process-identity.js";
import { ManagedProcessError } from "../process-supervisor.js";
import { capabilityGate } from "../profile.js";
import { ErrorCode, Errors, fail, success, type ToolResult, withErrorSchema } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { envValueDisplayAllowed, getEnvValueMode, redactText, SENSITIVE_ENV_KEYWORDS } from "../secret-governance.js";
import { validateHost } from "../security.js";
import { getShellSpec, shellResolutionFail } from "../shell.js";
import { registerManagedTool } from "../tool-registry.js";
import { safeExecFile } from "../utils.js";
import { wrapHandler } from "../wrap.js";

export interface SystemToolDependencies {
  processIdentityProvider?: ProcessIdentityProvider;
}

/** 精确名称必须只解析为一个 identity，否则不进入终止副作用。 */
async function findUniqueIdentity(
  provider: ProcessIdentityProvider,
  exactName: string,
): Promise<ProcessIdentity | ReturnType<typeof Errors.processIdentityAmbiguous>> {
  const candidates = await provider.findByExactName(exactName);
  if (candidates.length === 0) {
    return fail(ErrorCode.NOT_FOUND, "Process not found", { retryable: true, param: "name" });
  }
  if (candidates.length > 1) {
    return Errors.processIdentityAmbiguous("Exact process name is not unique; provide pid", {
      target_kind: "name",
      candidate_count: candidates.length,
    });
  }
  return candidates[0];
}

export function registerSystemTools(server: McpServer, dependencies: SystemToolDependencies = {}) {
  const processIdentityProvider = dependencies.processIdentityProvider ?? defaultProcessIdentityProvider;

  // ====================================================================
  registerManagedTool(
    server,
    "get_system_info",
    {
      title: "Get System Info",
      description: "Get detailed system information (OS, CPU, memory, disk, GPU, etc.).",
      inputSchema: z.object({}),
      outputSchema: withErrorSchema(z.object({ info: z.string() })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("get_system_info", async (_, context: RequestContext) => {
      const denied = capabilityGate(context, "host-process-inspection");
      if (denied) return denied;
      try {
        const spec = getSystemInfoSpec(await getShellSpec());
        const result = await safeExecFile(spec.file, spec.args, {
          timeout: 30000,
          signal: context.signal,
          requestId: context.requestId,
          scopeId: context.scopeId,
          kind: "system-info",
        });
        logger.info("get_system_info", "collected", "system info gathered");
        return success(result.stdout.trim(), { info: result.stdout.trim() });
      } catch (e: unknown) {
        if (e instanceof ManagedProcessError && e.cancelled) return Errors.cancelled("get_system_info cancelled");
        const m = e instanceof Error ? e.message : String(e);
        return shellResolutionFail(e) ?? Errors.executionFailed(m);
      }
    }),
  );

  // ====================================================================
  const ProcessListInput = z.object({
    filter: boundedString(SEARCH_BUDGET.processFilterMaxChars, 512).optional().describe("Filter processes by name"),
    top: finiteInt(1, SEARCH_BUDGET.processTopMax).optional().describe("Show top N processes by memory, default 20"),
  });
  type ProcessListInput = z.infer<typeof ProcessListInput>;

  registerManagedTool(
    server,
    "process_list",
    {
      title: "List Processes",
      description: "List running processes, optionally filter by name.",
      inputSchema: ProcessListInput,
      outputSchema: withErrorSchema(z.object({ output: z.string() })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("process_list", async ({ filter, top }: ProcessListInput, context: RequestContext) => {
      const denied = capabilityGate(context, "host-process-inspection");
      if (denied) return denied;
      // handler 层同源校验（直调路径）
      const inputErr =
        assertStringBounded(filter, {
          maxChars: SEARCH_BUDGET.processFilterMaxChars,
          maxBytes: 512,
          param: "filter",
        }) ?? assertIntRange(top, { min: 1, max: SEARCH_BUDGET.processTopMax, param: "top" });
      if (inputErr) return inputErr;
      try {
        const spec = getProcessListSpec(filter, top ?? 20, await getShellSpec());
        const result = await safeExecFile(spec.file, spec.args, {
          timeout: 10000,
          signal: context.signal,
          requestId: context.requestId,
          scopeId: context.scopeId,
          kind: "process-list",
        });
        return success(`Running Processes:\n${result.stdout.trim()}`, { output: result.stdout.trim() });
      } catch (e: unknown) {
        if (e instanceof ManagedProcessError && e.cancelled) return Errors.cancelled("process_list cancelled");
        const m = e instanceof Error ? e.message : String(e);
        return shellResolutionFail(e) ?? Errors.executionFailed(m);
      }
    }),
  );

  // ====================================================================
  const KillProcessInput = z.object({
    pid: finiteInt(1, 2_147_483_647).optional().describe("Process ID to kill"),
    name: boundedString(128, 512)
      .refine((value) => isExactProcessNameValid(value), {
        message: "name must be an exact process basename without wildcard or path characters",
      })
      .optional()
      .describe("Exact process basename to kill"),
    force: z.boolean().optional().describe("Force kill, default false"),
  });
  type KillProcessInput = z.infer<typeof KillProcessInput>;

  registerManagedTool(
    server,
    "kill_process",
    {
      title: "Kill Process",
      description: "Kill a process by PID or name. Refuses to kill critical system processes.",
      inputSchema: KillProcessInput,
      outputSchema: withErrorSchema(
        z.object({
          killed: z.boolean(),
          pid: z.number().optional(),
          name: z.string().optional(),
          tree: z.boolean().optional(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("kill_process", async ({ pid, name, force }: KillProcessInput) => {
      const target = parseKillTarget({ pid, name, force });
      if (isToolError(target)) return target;

      if (isProtectedInput(target.exactName, target.pid)) {
        return fail(
          ErrorCode.PROCESS_PROTECTED,
          "Cannot kill a protected system process (critical system process protection)",
          {
            retryable: false,
            param: target.pid !== undefined ? "pid" : "name",
          },
        );
      }

      const block = await guardDestructiveAction(
        "kill_process",
        `终止进程 ${target.exactName ?? target.pid ?? "(unknown)"}`,
      );
      if (block) {
        return fail(ErrorCode.SAFETY_BLOCKED, block, {
          retryable: false,
          param: target.pid !== undefined ? "pid" : "name",
        });
      }

      try {
        const identity =
          target.pid !== undefined
            ? await processIdentityProvider.inspectPid(target.pid)
            : await findUniqueIdentity(processIdentityProvider, target.exactName as string);
        if (isToolError(identity)) return identity;
        if (!isProcessIdentityValid(identity)) {
          return Errors.processIdentityAmbiguous("Unable to establish a safe process identity", {
            target_kind: target.pid !== undefined ? "pid" : "name",
          });
        }

        if (isProtectedProcessIdentity(identity) || isProtectedInput(identity.name, identity.pid)) {
          return fail(
            ErrorCode.PROCESS_PROTECTED,
            "Cannot kill a protected system process (critical system process protection)",
            {
              retryable: false,
              param: target.pid !== undefined ? "pid" : "name",
            },
          );
        }

        const termination = await processIdentityProvider.terminate(identity, target.force, target.force);
        if (isToolError(termination)) return termination;
        return success(`Killed: ${identity.name}`, {
          killed: true,
          pid: identity.pid,
          name: identity.name,
          tree: target.force,
        });
      } catch {
        return Errors.processIdentityAmbiguous("Unable to establish a safe process identity", {
          target_kind: target.pid !== undefined ? "pid" : "name",
        });
      }
    }),
  );

  // ====================================================================
  const NetworkInfoInput = z.object({
    action: z
      .enum(["config", "connections", "ping", "dns"])
      .optional()
      .describe("Action: config, connections, ping, dns. Default: config"),
    target: z.string().optional().describe("Target host (required for ping/dns)"),
  });
  type NetworkInfoInput = z.infer<typeof NetworkInfoInput>;

  registerManagedTool(
    server,
    "network_info",
    {
      title: "Network Info",
      description: "Get network configuration and connectivity info.",
      inputSchema: NetworkInfoInput,
      outputSchema: withErrorSchema(z.object({ output: z.string(), action: z.string() })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("network_info", async ({ action, target }: NetworkInfoInput, context: RequestContext) => {
      const denied = capabilityGate(context, "network-egress");
      if (denied) return denied;
      try {
        const act = action || "config";
        // egress 目标必填：拒绝缺参，不再隐式回退 127.0.0.1/localhost（该默认路径曾绕过校验）
        if (act === "ping" || act === "dns") {
          if (!target || target.trim().length === 0) {
            return fail(ErrorCode.VALIDATION_ERROR, `target is required for action "${act}"`, {
              retryable: true,
              param: "target",
              suggestion: "Provide the host to ping or resolve",
            });
          }
          const hostErr = validateHost(target);
          if (hostErr) return fail(ErrorCode.HOST_INVALID, hostErr, { retryable: true, param: "target" });
          // egress 校验（SEC-07）：目标经 DNS/IP 分类策略判定；默认 allow-private 保持诊断可用
          const egress = await validateTarget(target, "network_info");
          if (!egress.ok) return egress.result;
          if (egress.value.warning) logger.warn("network_info", "bad-ssrf-mode", egress.value.warning);
        }
        const spec = getNetworkSpec(act, target);
        const result = await safeExecFile(spec.file, spec.args, {
          timeout: 15000,
          signal: context.signal,
          requestId: context.requestId,
          scopeId: context.scopeId,
          kind: "network-info",
        });
        return success(result.stdout.trim(), { output: result.stdout.trim(), action: act });
      } catch (e: unknown) {
        if (e instanceof ManagedProcessError && e.cancelled) return Errors.cancelled("network_info cancelled");
        const m = e instanceof Error ? e.message : String(e);
        return Errors.executionFailed(m);
      }
    }),
  );

  // ====================================================================
  const EnvironmentVarsInput = z.object({
    action: z.enum(["get", "list"]).describe("get = get one var, list = list all"),
    name: z.string().optional().describe("Variable name (required for get)"),
  });
  type EnvironmentVarsInput = z.infer<typeof EnvironmentVarsInput>;

  registerManagedTool(
    server,
    "environment_vars",
    {
      title: "Environment Variables",
      description: "Get or list environment variables (sensitive keys hidden).",
      inputSchema: EnvironmentVarsInput,
      outputSchema: withErrorSchema(z.object({ vars: z.record(z.string()).optional(), value: z.string().optional() })),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler(
      "environment_vars",
      async ({ action, name }: EnvironmentVarsInput, context: RequestContext): Promise<ToolResult> => {
        const denied = capabilityGate(context, "host-environment-read");
        if (denied) return denied;
        // get 缺 name 显式拒绝：不再静默降级为 list
        if (action === "get" && (!name || name.trim().length === 0)) {
          return fail(ErrorCode.VALIDATION_ERROR, 'name is required for action "get"', {
            retryable: true,
            param: "name",
            suggestion: "Provide the environment variable name to read",
          });
        }
        try {
          // 值展示策略告警由消费方输出（secret-governance 不导入 logger）
          const { warning } = getEnvValueMode();
          if (warning) logger.warn("environment_vars", "bad-env-value-mode", warning);

          if (action === "get" && name) {
            if (SENSITIVE_ENV_KEYWORDS.test(name) || !envValueDisplayAllowed(name)) {
              return success(`${name}=*** (hidden)`, { value: "***" });
            }
            const shown = redactText(process.env[name] || "");
            return success(`${name}=${shown}`, { value: shown });
          }

          const vars: Record<string, string> = {};
          const entries = Object.entries(process.env)
            .filter(([k]) => k.length > 0)
            .sort(([a], [b]) => a.localeCompare(b));

          for (const [k, v] of entries) {
            // 白名单外/敏感 key 掩码；展示值过 redactor
            vars[k] = envValueDisplayAllowed(k) ? redactText(String(v ?? "")) : "***";
          }

          const allLines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
          const maxVars = 100;
          const truncated = allLines.length > maxVars;
          const text = truncated
            ? `${allLines.slice(0, maxVars).join("\n")}\n... (${allLines.length - maxVars} more)`
            : allLines.join("\n");
          return success(`Environment Variables (sensitive keys hidden):\n${text}`, { vars });
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          return Errors.executionFailed(m);
        }
      },
    ),
  );
}
