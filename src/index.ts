#!/usr/bin/env node
/**
 * Enhanced Terminal MCP Server — 入口
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
import { audit } from "./audit.js";
import { logger } from "./logger.js";
import { processPool } from "./pool.js";
import { initSafeGuard } from "./safeguard.js";
import { session } from "./session.js";
import { tempManager } from "./temp-manager.js";
import { registerArchiveTools } from "./tools/archive.js";
// 工具模块
import { registerCommandTools } from "./tools/command.js";
import { registerFileTools } from "./tools/files.js";
import { registerManageTools } from "./tools/manage.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSystemTools } from "./tools/system.js";
import { registerUtilityTools } from "./tools/utility.js";
import { VERSION } from "./version.js";

async function main() {
  const server = new McpServer({
    name: "enhanced-terminal-mcp",
    version: VERSION,
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
  registerUtilityTools(server);

  // 注册审计日志资源
  server.resource("audit-log", new ResourceTemplate("audit://log", { list: undefined }), async (uri) => {
    const url = new URL(uri.href);
    const limit = parseInt(url.searchParams.get("limit") || "50", 10) || 50;
    const entries = await audit.recent(Math.min(limit, 1000));
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(entries, null, 2) }],
    };
  });

  // 启动进程池清理定时器（惰性：不在模块加载时启动）
  processPool.startSweep();

  // 初始化临时资源管理器（启动自动清理轮询）
  await tempManager.init();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅退出：清理进程池与临时资源
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server", "shutdown", "Graceful shutdown initiated");
    session.flush().catch((e) => logger.warn("server", "session-flush-failed", String(e)));
    audit.flush().catch((e) => logger.warn("server", "audit-flush-failed", String(e)));
    processPool.destroy();
    tempManager.stopAutoCleanup();
    // 给 pending I/O 时间完成
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info(
    "server",
    "started",
    `Enhanced Terminal MCP v${VERSION} | safety=${process.env.MCP_SAFETY_MODE || "normal"} | 27 tools`,
  );
}

main().catch((e) => {
  console.error("[FATAL] Server crashed:", e);
  process.exit(1);
});
