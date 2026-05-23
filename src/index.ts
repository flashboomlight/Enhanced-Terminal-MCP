/**
 * Enhanced Terminal MCP Server — 入口 v3.1
 * 
 * 架构:
 *   工具注册层 → 中间件链(审计/安全/缓存) → 执行层(tool handlers) → 结果格式化(outputSchema)
 * 
 * 新增能力:
 *   - LRU 结果缓存 (idempotent 只读工具复用)
 *   - Telemetry 指标收集 (延迟/错误率/缓存命中率)
 *   - Session 工作目录状态管理
 *   - 分页游标支持
 *   - 工具执行遥测面板
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initSafeGuard } from "./safeguard.js";
import { validatePath } from "./security.js";
import { logger } from "./logger.js";
import { toolCache, CACHEABLE_TOOLS } from "./cache.js";
import { telemetry } from "./telemetry.js";
import { session } from "./session.js";
import { processPool } from "./pool.js";
import * as fs from "fs/promises";

// 工具模块
import { registerCommandTools } from "./tools/command.js";
import { registerFileTools } from "./tools/files.js";
import { registerManageTools } from "./tools/manage.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSystemTools } from "./tools/system.js";
import { registerArchiveTools } from "./tools/archive.js";

import * as z from "zod";

async function main() {
  const server = new McpServer({
    name: "enhanced-terminal-mcp",
    version: "3.1.0",
  });

  // 初始化安全引擎
  initSafeGuard(server);

  // 注册所有核心工具
  registerCommandTools(server);
  registerFileTools(server);
  registerManageTools(server);
  registerSearchTools(server);
  registerSystemTools(server);
  registerArchiveTools(server);

  // 启动进程池清理定时器（惰性：不在模块加载时启动）
  processPool.startSweep();

  // ====================================================================
  // 新增工具: telemetry_report — 工具调用指标面板
  // ====================================================================
  server.registerTool(
    "telemetry_report",
    {
      title: "Telemetry Report",
      description: "Get tool call metrics: latency, error rates, cache hit rates per tool. Use to debug performance.",
      inputSchema: z.object({
        recent: z.number().optional().describe("Show recent N calls, default 20"),
      }),
      outputSchema: z.object({
        summary: z.string(),
        uptime_minutes: z.number(),
        total_calls: z.number(),
        avg_latency_ms: z.number(),
        error_rate: z.string(),
        cache_hit_rate: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ recent }) => {
      const n = recent || 20;
      const s = telemetry.summary();
      const recentCalls = telemetry.recent(n);
      const recentText = recentCalls.map(m => `  ${m.toolName}: ${m.latency_ms}ms ${m.ok ? "OK" : "FAIL"}`).join("\n");
      const text = `Uptime: ${s.uptime_minutes}min | Calls: ${s.total_calls} | Avg: ${s.avg_latency_ms}ms | Errors: ${s.error_rate} | Cache: ${s.cache_hit_rate}\n\nRecent ${n}:\n${recentText}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          summary: text,
          uptime_minutes: s.uptime_minutes,
          total_calls: s.total_calls,
          avg_latency_ms: s.avg_latency_ms,
          error_rate: s.error_rate,
          cache_hit_rate: s.cache_hit_rate,
        },
      };
    }
  );

  // ====================================================================
  // 新增工具: cache_stats — 缓存统计面板
  // ====================================================================
  server.registerTool(
    "cache_stats",
    {
      title: "Cache Statistics",
      description: "Get LRU cache statistics: size, hit rate, capacity. Use to understand cache effectiveness.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        size: z.number(),
        max_size: z.number(),
        hits: z.number(),
        misses: z.number(),
        hit_rate: z.string(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const stats = toolCache.stats;
      const text = `Cache: ${stats.size}/${stats.maxSize} entries, ${stats.hits} hits, ${stats.misses} misses (${stats.hitRate})`;
      return {
        content: [{ type: "text", text }],
        structuredContent: stats,
      };
    }
  );

  // ====================================================================
  // 新增工具: cache_invalidate — 清除缓存
  // ====================================================================
  server.registerTool(
    "cache_invalidate",
    {
      title: "Invalidate Cache",
      description: "Clear all or specific tool caches. Use when results become stale.",
      inputSchema: z.object({
        tool: z.string().optional().describe("Clear cache for specific tool only, or all if omitted"),
      }),
      outputSchema: z.object({ cleared: z.number() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ tool }) => {
      const sizeBefore = toolCache.stats.size;
      const cleared = tool
        ? toolCache.invalidatePrefix(tool + ":")
        : (toolCache.clear(), sizeBefore);
      return {
        content: [{ type: "text", text: tool ? `Cleared cache for: ${tool} (${cleared} entries)` : `Cleared all caches (${cleared} entries)` }],
        structuredContent: { cleared },
      };
    }
  );

  // ====================================================================
  // 新增工具: session_state — 会话状态查看/设置
  // ====================================================================
  server.registerTool(
    "session_state",
    {
      title: "Session State",
      description: "View or modify session state: working directory, environment variables.",
      inputSchema: z.object({
        action: z.enum(["get", "set_cwd", "set_env", "reset"]).describe("get=view state, set_cwd=change working dir, set_env=set env var, reset=clear session"),
        cwd: z.string().optional().describe("New working directory (for set_cwd)"),
        key: z.string().optional().describe("Env var name (for set_env)"),
        value: z.string().optional().describe("Env var value (for set_env)"),
      }),
      outputSchema: z.object({
        snapshot: z.any(),
        changed: z.boolean(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ action, cwd, key, value }) => {
      let changed = false;
      if (action === "set_cwd" && cwd) {
        const pathErr = validatePath(cwd, "session_state:set_cwd");
        if (pathErr) return { content: [{ type: "text" as const, text: `Error: ${pathErr}` }], structuredContent: { snapshot: session.snapshotObj(), changed: false } };
        try { const stat = await fs.stat(cwd); if (!stat.isDirectory()) throw new Error("not a directory"); } catch {
          return { content: [{ type: "text" as const, text: `Error: path does not exist or is not a directory: ${cwd}` }], structuredContent: { snapshot: session.snapshotObj(), changed: false } };
        }
        session.setCwd(cwd); changed = true;
      }
      if (action === "set_env" && key && value !== undefined) {
        if (!key.trim() || key.includes("=") || key.length > 256) {
          return { content: [{ type: "text" as const, text: `Error: invalid env key "${key}" (must be non-empty, no '=', max 256 chars)` }], structuredContent: { snapshot: session.snapshotObj(), changed: false } };
        }
        if (typeof value === "string" && value.length > 32768) {
          return { content: [{ type: "text" as const, text: `Error: env value too long (max 32768 chars)` }], structuredContent: { snapshot: session.snapshotObj(), changed: false } };
        }
        session.setEnv(key, value); changed = true;
      }
      if (action === "reset") { session.reset(); changed = true; }

      const snap = session.snapshotObj();
      return {
        content: [{ type: "text", text: JSON.stringify(snap, null, 2) }],
        structuredContent: { snapshot: snap, changed },
      };
    }
  );

  // ====================================================================
  // 新增工具: pool_stats — 进程池状态
  // ====================================================================
  server.registerTool(
    "pool_stats",
    {
      title: "Process Pool Stats",
      description: "Get shell process pool statistics: idle/busy processes, pool capacity.",
      inputSchema: z.object({}),
      outputSchema: z.object({ size: z.number(), idle: z.number(), busy: z.number(), max: z.number() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const stats = processPool.stats;
      const text = `Process Pool: ${stats.size}/${stats.max} processes (${stats.busy} busy, ${stats.idle} idle)`;
      return {
        content: [{ type: "text", text }],
        structuredContent: stats,
      };
    }
  );

  // 注册资源: 健康检查（含版本/指标）
  // ====================================================================
  server.resource(
    "health",
    new ResourceTemplate("health://status", { list: undefined }),
    async () => {
      const s = telemetry.summary();
      return {
        contents: [{
          uri: "health://status",
          text: JSON.stringify({
            status: "ok",
            version: "3.1.0",
            timestamp: new Date().toISOString(),
            metrics: {
              uptime_minutes: s.uptime_minutes,
              total_calls: s.total_calls,
              avg_latency_ms: s.avg_latency_ms,
              error_rate: s.error_rate,
              cache_hit_rate: s.cache_hit_rate,
            },
            cache: toolCache.stats,
            session: session.snapshot(),
          }, null, 2),
        }],
      };
    }
  );

  // 注册 prompts
  server.prompt("usage-guide", "How to use Enhanced Terminal MCP tools", async () => ({
    messages: [{ role: "user", content: { type: "text", text: `Enhanced Terminal MCP v3.1 provides 26 tools for file operations, command execution, search, and telemetry.

NEW in v3.1:
- telemetry_report: View tool call metrics (latency, error rate, cache hit rate)
- cache_stats / cache_invalidate: Manage LRU result cache
- session_state: Manage session working directory and env context
- All tools now return structured output with outputSchema for LLM chainable decisions
- Structured error codes with retryable/suggestion hints
- Safety mode: strict/normal/off via MCP_SAFETY_MODE env var` } }],
  }));

  server.prompt("safety-info", "Current safety configuration", async () => ({
    messages: [{ role: "user", content: { type: "text", text: JSON.stringify({ version: "3.1.0", safety: process.env.MCP_SAFETY_MODE || "normal", tools: 26, cache: toolCache.stats }, null, 2) } }],
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅退出：清理进程池
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server", "shutdown", "Graceful shutdown initiated");
    processPool.destroy();
    // 给 pending I/O 时间完成
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info("server", "started", `Enhanced Terminal MCP v3.1.0 | safety=${process.env.MCP_SAFETY_MODE || "normal"} | 26 tools`);
}

main().catch((e) => {
  console.error("[FATAL] Server crashed:", e);
  process.exit(1);
});
