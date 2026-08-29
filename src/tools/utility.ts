/**
 * Utility/meta tools: telemetry_report, cache_stats, cache_invalidate, session_state, pool_stats
 */

import * as fs from "node:fs/promises";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { audit } from "../audit.js";
import { toolCache } from "../cache.js";
import { injectContext } from "../context.js";
import { logger } from "../logger.js";
import { processPool } from "../pool.js";
import { processSupervisor } from "../process-supervisor.js";
import { ErrorCode, fail, success, type ToolResult, withErrorSchema } from "../result.js";
import { getSafetyMode, getSafetyProtocolVersion, supportsFormElicitation } from "../safeguard.js";
import { validateEnvKeyPolicy } from "../secret-governance.js";
import { validatePath } from "../security.js";
import { session } from "../session.js";
import { getStateDirSync } from "../state-dir.js";
import { telemetry } from "../telemetry.js";
import { tempManager } from "../temp-manager.js";
import { getAllRegisteredToolNames, getRegisteredToolCount, registerManagedTool } from "../tool-registry.js";
import { VERSION } from "../version.js";
import { wrapHandler } from "../wrap.js";

/** 格式化缓存清理结果文本 */
export function formatCacheInvalidateMessage(tool: string | undefined, cleared: number): string {
  return tool ? `Cleared cache for: ${tool} (${cleared} entries)` : `Cleared all caches (${cleared} entries)`;
}

/** 校验环境变量 key（委托 secret-governance：形状 + deny 大小写规范化） */
export function validateEnvKey(key: string): string | null {
  return validateEnvKeyPolicy(key);
}

/** 校验环境变量 value */
export function validateEnvValue(value: string): string | null {
  if (value.length > 32768) {
    return "env value too long";
  }
  return null;
}

/** 格式化进程池统计文本（当前池未激活，始终为空） */
export function formatPoolStatsMessage(stats: {
  size: number;
  max: number;
  busy: number;
  idle: number;
  active?: boolean;
}): string {
  const flag = stats.active === false || stats.active === undefined ? "inactive, spawnStream on demand" : "active";
  return `Process Pool (${flag}): ${stats.size}/${stats.max} processes (${stats.busy} busy, ${stats.idle} idle)`;
}

/** 格式化缓存统计文本 */
export function formatCacheStatsMessage(stats: {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  hitRate: string;
}): string {
  return `Cache: ${stats.size}/${stats.maxSize} entries, ${stats.hits} hits, ${stats.misses} misses (${stats.hitRate})`;
}

/** 格式化临时资源统计文本 */
export function formatTempStatsMessage(stats: {
  total_dirs: number;
  total_size_bytes: number;
  oldest_dir_ms: number;
  newest_dir_ms: number;
  removed_count: number;
  active_dirs: number;
  reserved_bytes: number;
}): string {
  return `Temp dirs: ${stats.total_dirs}, total size: ${stats.total_size_bytes} bytes, oldest: ${stats.oldest_dir_ms}ms, newest: ${stats.newest_dir_ms}ms, removed: ${stats.removed_count}, active: ${stats.active_dirs}, reserved: ${stats.reserved_bytes} bytes`;
}

/** 格式化 telemetry 报告文本 */
export function formatTelemetryText(
  summary: {
    uptime_minutes: number;
    total_calls: number;
    avg_latency_ms: number;
    error_rate: string;
    cache_hit_rate: string;
  },
  recentCalls: Array<{ toolName: string; latency_ms: number; ok: boolean }>,
  tempStats: {
    total_dirs: number;
    total_size_bytes: number;
    oldest_dir_ms: number;
    newest_dir_ms: number;
    removed_count: number;
    active_dirs: number;
    reserved_bytes: number;
  },
  auditSummary: { mode: string; enabled: boolean },
  auditState?: string,
): string {
  const recentText = recentCalls.map((m) => `  ${m.toolName}: ${m.latency_ms}ms ${m.ok ? "OK" : "FAIL"}`).join("\n");
  const auditLine = auditState
    ? `Audit: mode=${auditSummary.mode}, enabled=${auditSummary.enabled}, state=${auditState}`
    : `Audit: mode=${auditSummary.mode}, enabled=${auditSummary.enabled}`;
  return `Uptime: ${summary.uptime_minutes}min | Calls: ${summary.total_calls} | Avg: ${summary.avg_latency_ms}ms | Errors: ${summary.error_rate} | Cache: ${summary.cache_hit_rate}\n\nTemp dirs: ${tempStats.total_dirs}, temp size: ${tempStats.total_size_bytes} bytes, removed: ${tempStats.removed_count}\n${auditLine}\n\nRecent ${recentCalls.length}:\n${recentText}`;
}

/**
 * truthful health 聚合（production-hardening #8）：
 * 任一组件 failed → failed；任一 degraded → degraded；否则 healthy。
 * 组件：audit 写入面 / temp 容量与清理锁 / process 终止失败 / session 持久化。
 */
export function computeHealthStatus(components: {
  audit: { state: string };
  temp: { state: string };
  process: { state: string };
  session: { state: string };
}): "healthy" | "degraded" | "failed" {
  const states = [components.audit.state, components.temp.state, components.process.state, components.session.state];
  if (states.includes("failed")) return "failed";
  if (states.includes("degraded")) return "degraded";
  return "healthy";
}

export function registerUtilityTools(server: McpServer) {
  // ====================================================================
  registerManagedTool(
    server,
    "telemetry_report",
    {
      title: "Telemetry Report",
      description: "Get tool call metrics: latency, error rates, cache hit rates per tool. Use to debug performance.",
      inputSchema: z.object({
        recent: z.number().optional().describe("Show recent N calls, default 20"),
      }),
      outputSchema: withErrorSchema(
        z.object({
          summary: z.string(),
          uptime_minutes: z.number(),
          total_calls: z.number(),
          avg_latency_ms: z.number(),
          error_rate: z.string(),
          cache_hit_rate: z.string(),
          temp: z.object({
            total_dirs: z.number(),
            total_size_bytes: z.number(),
            oldest_dir_ms: z.number(),
            newest_dir_ms: z.number(),
            removed_count: z.number(),
            active_dirs: z.number(),
            reserved_bytes: z.number(),
          }),
          audit: z.object({
            mode: z.string(),
            enabled: z.boolean(),
            state: z.string(),
            queued: z.number(),
            dropped: z.number(),
          }),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("telemetry_report", async ({ recent }: { recent?: number }): Promise<ToolResult> => {
      const n = recent || 20;
      const s = telemetry.summary();
      const recentCalls = telemetry.recent(n);
      const tempStats = await tempManager.stats();
      const auditSummary = audit.summary();
      const text = formatTelemetryText(s, recentCalls, tempStats, auditSummary, auditSummary.state);
      return success(text, {
        summary: text,
        uptime_minutes: s.uptime_minutes,
        total_calls: s.total_calls,
        avg_latency_ms: s.avg_latency_ms,
        error_rate: s.error_rate,
        cache_hit_rate: s.cache_hit_rate,
        temp: tempStats,
        audit: auditSummary,
      });
    }),
  );

  // ====================================================================
  registerManagedTool(
    server,
    "cache_stats",
    {
      title: "Cache Statistics",
      description: "Get LRU cache statistics: size, hit rate, capacity. Use to understand cache effectiveness.",
      inputSchema: z.object({}),
      outputSchema: withErrorSchema(
        z.object({
          size: z.number(),
          max_size: z.number(),
          hits: z.number(),
          misses: z.number(),
          hit_rate: z.string(),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("cache_stats", async (): Promise<ToolResult> => {
      const stats = toolCache.stats;
      return success(formatCacheStatsMessage(stats), {
        size: stats.size,
        max_size: stats.maxSize,
        hits: stats.hits,
        misses: stats.misses,
        hit_rate: stats.hitRate,
      });
    }),
  );

  // ====================================================================
  registerManagedTool(
    server,
    "cache_invalidate",
    {
      title: "Invalidate Cache",
      description: "Clear all or specific tool caches. Use when results become stale.",
      inputSchema: z.object({
        tool: z.string().optional().describe("Clear cache for specific tool only, or all if omitted"),
      }),
      outputSchema: withErrorSchema(z.object({ cleared: z.number() })),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("cache_invalidate", async ({ tool }: { tool?: string }): Promise<ToolResult> => {
      const sizeBefore = toolCache.stats.size;
      const cleared = tool
        ? toolCache.invalidatePrefix(`${tool}:`)
        : (() => {
            const sz = sizeBefore;
            toolCache.clear();
            return sz;
          })();
      audit.record({
        action: "cache.invalidate",
        tool: "cache_invalidate",
        detail: { tool, cleared },
        success: true,
      });
      return success(formatCacheInvalidateMessage(tool, cleared), { cleared });
    }),
  );

  // ====================================================================
  registerManagedTool(
    server,
    "session_state",
    {
      title: "Session State",
      description: "View or modify session state: working directory, environment variables.",
      inputSchema: z.object({
        action: z
          .enum(["get", "set_cwd", "set_env", "reset"])
          .describe("get=view state, set_cwd=change working dir, set_env=set env var, reset=clear session"),
        cwd: z.string().optional().describe("New working directory (required for set_cwd)"),
        key: z.string().optional().describe("Env var name (required for set_env)"),
        value: z.string().optional().describe("Env var value (required for set_env; may be empty string)"),
      }),
      outputSchema: withErrorSchema(
        z.object({
          snapshot: z.object({
            cwd: z.string(),
            envKeys: z.array(z.string()),
            historyLength: z.number(),
            uptimeMinutes: z.number(),
          }),
          changed: z.boolean(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    wrapHandler(
      "session_state",
      async ({
        action,
        cwd,
        key,
        value,
      }: {
        action: string;
        cwd?: string;
        key?: string;
        value?: string;
      }): Promise<ToolResult> => {
        let changed = false;
        // action 枚举外值直接拒绝（schema 是 enum，但签名退化为 string）
        if (action !== "get" && action !== "set_cwd" && action !== "set_env" && action !== "reset") {
          return fail(ErrorCode.VALIDATION_ERROR, `Unknown action: ${action}`, {
            retryable: false,
            param: "action",
            suggestion: "Use one of: get, set_cwd, set_env, reset",
          });
        }
        // set_cwd 缺 cwd 显式拒绝：不再静默返回快照
        if (action === "set_cwd" && (!cwd || cwd.trim().length === 0)) {
          return fail(ErrorCode.VALIDATION_ERROR, 'cwd is required for action "set_cwd"', {
            retryable: true,
            param: "cwd",
            suggestion: "Provide the new working directory",
          });
        }
        if (action === "set_cwd" && cwd) {
          const pathErr = validatePath(cwd, "session_state:set_cwd");
          if (pathErr) {
            audit.record({
              action: "session.set_cwd",
              tool: "session_state",
              detail: { cwd },
              success: false,
              error: pathErr,
            });
            return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "cwd" });
          }
          try {
            const stat = await fs.stat(cwd);
            if (!stat.isDirectory()) throw new Error("not a directory");
          } catch (err) {
            logger.debug("session_state", "cwd-stat-failed", String(err));
            audit.record({
              action: "session.set_cwd",
              tool: "session_state",
              detail: { cwd },
              success: false,
              error: "not a directory",
            });
            return fail(ErrorCode.PATH_NOT_FOUND, `path does not exist or is not a directory: ${cwd}`, {
              retryable: true,
              param: "cwd",
            });
          }
          try {
            session.setCwd(cwd);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return fail(ErrorCode.PATH_FORBIDDEN, msg, { retryable: false, param: "cwd" });
          }
          audit.record({
            action: "session.set_cwd",
            tool: "session_state",
            detail: { cwd },
            success: true,
          });
          changed = true;
        }
        // set_env 缺 key/value 显式拒绝：不再静默返回快照（value 允许空串，但必须出现）
        if (action === "set_env" && (!key || key.trim().length === 0 || value === undefined)) {
          return fail(ErrorCode.VALIDATION_ERROR, 'key and value are required for action "set_env"', {
            retryable: true,
            param: value === undefined ? "value" : "key",
            suggestion: "Provide the env var name and value (value may be an empty string)",
          });
        }
        if (action === "set_env" && key && value !== undefined) {
          const keyErr = validateEnvKey(key);
          if (keyErr) {
            audit.record({
              action: "session.set_env",
              tool: "session_state",
              detail: { key },
              success: false,
              error: keyErr,
            });
            return fail(ErrorCode.VALIDATION_ERROR, keyErr, {
              retryable: false,
              param: "key",
              suggestion: "Use a non-empty key without '=' (max 256 chars) outside the persistence deny list",
            });
          }
          const valueErr = validateEnvValue(value);
          if (valueErr) {
            audit.record({
              action: "session.set_env",
              tool: "session_state",
              detail: { key },
              success: false,
              error: valueErr,
            });
            return fail(ErrorCode.VALIDATION_ERROR, `env value too long (max 32768 chars)`, {
              retryable: false,
              param: "value",
            });
          }
          try {
            session.setEnv(key, value);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return fail(ErrorCode.VALIDATION_ERROR, msg, { retryable: false, param: "key" });
          }
          audit.record({
            action: "session.set_env",
            tool: "session_state",
            detail: { key },
            success: true,
          });
          changed = true;
        }
        if (action === "reset") {
          session.reset();
          audit.record({
            action: "session.reset",
            tool: "session_state",
            detail: {},
            success: true,
          });
          changed = true;
        }

        const snap = session.snapshotObj();
        return success(JSON.stringify(snap, null, 2), { snapshot: snap, changed });
      },
    ),
  );

  // ====================================================================
  registerManagedTool(
    server,
    "pool_stats",
    {
      title: "Process Pool Stats",
      description:
        "Shell process pool stats. Currently inactive (execution uses on-demand spawnStream); size/idle/busy are always 0, max is capacity reserved for a future pool.",
      inputSchema: z.object({}),
      outputSchema: withErrorSchema(
        z.object({
          size: z.number(),
          idle: z.number(),
          busy: z.number(),
          max: z.number(),
          active: z.boolean().describe("Whether pre-warmed pool is wired into command execution"),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("pool_stats", async (): Promise<ToolResult> => {
      const stats = processPool.stats;
      return success(formatPoolStatsMessage(stats), {
        size: stats.size,
        idle: stats.idle,
        busy: stats.busy,
        max: stats.max,
        active: stats.active,
      });
    }),
  );

  // ====================================================================
  registerManagedTool(
    server,
    "temp_stats",
    {
      title: "Temp Resource Stats",
      description: "Get temporary resource statistics: total directories, size, oldest/newest age, removed count.",
      inputSchema: z.object({}),
      outputSchema: withErrorSchema(
        z.object({
          total_dirs: z.number(),
          total_size_bytes: z.number(),
          oldest_dir_ms: z.number(),
          newest_dir_ms: z.number(),
          removed_count: z.number(),
          active_dirs: z.number(),
          reserved_bytes: z.number(),
        }),
      ),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    wrapHandler("temp_stats", async (): Promise<ToolResult> => {
      const stats = await tempManager.stats();
      return success(formatTempStatsMessage(stats), stats);
    }),
  );

  logger.info("utility_tools", "registered", "6 utility tools registered");

  // ====================================================================
  // 资源: 健康检查
  // ====================================================================
  server.resource("health", new ResourceTemplate("health://status", { list: undefined }), async () => {
    const s = telemetry.summary();
    const tempStats = await tempManager.stats();
    const auditSummary = audit.summary();
    const auditHealth = audit.health();
    const tempHealth = tempManager.health();
    const sessionHealth = session.health();
    // truthful health（roadmap §5.7）：process 组件以终止失败为准——曾有 child 无法保证被清理即 degraded
    const processHealth = {
      state: processSupervisor.getTerminationFailureCount() > 0 ? ("degraded" as const) : ("healthy" as const),
      terminationFailures: processSupervisor.getTerminationFailureCount(),
    };
    const status = computeHealthStatus({
      audit: { state: auditHealth.state },
      temp: { state: tempHealth.state },
      process: { state: processHealth.state },
      session: { state: sessionHealth.state },
    });
    const auditLogFile = await audit.getLogFilePath();
    const stateDir = getStateDirSync();
    return {
      contents: [
        {
          uri: "health://status",
          text: JSON.stringify(
            {
              status,
              version: VERSION,
              timestamp: new Date().toISOString(),
              safety_protocol_version: getSafetyProtocolVersion(),
              safety_mode: getSafetyMode(),
              elicitation_supported: supportsFormElicitation(),
              state_dir: stateDir,
              components: {
                audit: auditHealth,
                temp: tempHealth,
                process: processHealth,
                session: sessionHealth,
              },
              metrics: {
                uptime_minutes: s.uptime_minutes,
                total_calls: s.total_calls,
                avg_latency_ms: s.avg_latency_ms,
                error_rate: s.error_rate,
                cache_hit_rate: s.cache_hit_rate,
              },
              cache: toolCache.stats,
              session: session.snapshot(),
              temp: tempStats,
              audit: { ...auditSummary, log_file: auditLogFile },
              tools: {
                enabled: getRegisteredToolCount(),
                disabled: getAllRegisteredToolNames().length - getRegisteredToolCount(),
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  });

  // ====================================================================
  // Prompts
  // ====================================================================
  server.prompt("usage-guide", "How to use Enhanced Terminal MCP tools", async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: injectContext(`Enhanced Terminal MCP v${VERSION} provides ${getRegisteredToolCount()} tools for file operations, command execution, search, telemetry, and temp resources.

NEW in v4.0:
- Risk-gated command confirmation: MCP_COMMAND_CONFIRMATION=all|risk-gated; heavy commands confirm once with the risk reason, and the hardBlock floor stays unclosable in every mode
- Execution profiles: local-trusted-shell (default) vs sandboxed-production capability matrix; undeclared capabilities fail closed with CAPABILITY_DENIED
- Partial-result contract: search/list tools return complete/truncated/warnings with structured warning codes instead of silently swallowing read failures
- Bounded responses: MCP_RESPONSE_MAX_BYTES output budget; oversized results return RESOURCE_LIMIT instead of unbounded payloads
- Truthful health://status: healthy/degraded/failed aggregated from the audit writer, temp capacity, process supervisor, and session persistence
- telemetry_report: view tool call metrics (latency, error rate, cache hit rate, temp stats, audit state)
- temp_stats: view temporary resource usage and auto-recycled counts
- execute_command paging: use cache_id/page/pageSize to read large outputs incrementally without re-running commands
- audit logging: structured JSON Lines log at .etmcp/logs/audit.jsonl with size-based rotation
- session_state: manage session working directory and env context
- cache_stats / cache_invalidate: manage the LRU result cache
- All tools return structured output with outputSchema for LLM-chainable decisions; error codes carry retryable/suggestion hints
- Safety mode: strict/normal/off via MCP_SAFETY_MODE env var`),
        },
      },
    ],
  }));

  server.prompt("safety-info", "Current safety configuration", async () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: JSON.stringify(
            {
              version: VERSION,
              safety_protocol_version: getSafetyProtocolVersion(),
              safety: getSafetyMode(),
              elicitation_supported: supportsFormElicitation(),
              tools: getRegisteredToolCount(),
              cache: toolCache.stats,
            },
            null,
            2,
          ),
        },
      },
    ],
  }));
}
