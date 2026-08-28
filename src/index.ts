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
import { processSupervisor } from "./process-supervisor.js";
import { initializeExecutionProfile } from "./profile.js";
import { initSafeGuard } from "./safeguard.js";
import { redactError } from "./secret-governance.js";
import { session } from "./session.js";
import { tempManager } from "./temp-manager.js";
import { getRegisteredToolCount } from "./tool-registry.js";
import { registerArchiveTools } from "./tools/archive.js";
// 工具模块
import { registerCommandTools } from "./tools/command.js";
import { registerFileTools } from "./tools/files.js";
import { registerManageTools } from "./tools/manage.js";
import { registerSearchTools } from "./tools/search.js";
import { registerSystemTools } from "./tools/system.js";
import { registerUtilityTools } from "./tools/utility.js";
import { VERSION } from "./version.js";

/** 读取审计日志资源，兼容裸 URI 与带 limit 查询参数的 URI。 */
async function readAuditLog(uri: URL) {
  const requestedLimit = Number.parseInt(uri.searchParams.get("limit") || "50", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 1000) : 50;
  const entries = await audit.recent(Math.min(limit, 1000));
  return {
    contents: [{ uri: uri.href, text: JSON.stringify(entries, null, 2) }],
  };
}

async function main() {
  initializeExecutionProfile();

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

  // 注册审计日志资源：固定 URI 保持兼容，URI template 支持 ?limit=N。
  server.resource("audit-log", "audit://log", readAuditLog);
  server.resource(
    "audit-log-with-limit",
    new ResourceTemplate("audit://log{?limit}", { list: undefined }),
    readAuditLog,
  );

  // 启动进程池清理定时器（惰性：不在模块加载时启动）
  processPool.startSweep();

  // 初始化临时资源管理器（启动自动清理轮询）
  await tempManager.init();
  // 等待 session 从磁盘恢复完成，确保接受请求前 cwd/env 已就绪
  await session.loaded;

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 优雅退出：先 drain 所有 managed child，再 flush session/audit
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("server", "shutdown", "Graceful shutdown initiated");
    processPool.destroy();
    tempManager.stopAutoCleanup();
    void (async () => {
      const report = await processSupervisor.shutdown(3000);
      if (!report.clean) {
        process.exitCode = 1;
        logger.error("server", "shutdown-degraded", JSON.stringify(report));
      }
      try {
        await session.flush();
      } catch (error) {
        process.exitCode = 1;
        logger.warn("server", "session-flush-failed", String(error));
      }
      try {
        // audit flush 不再丢条目：deadline 内没写完的滞留条目必须可见（exitCode 1）
        const report = await audit.flush(3000);
        if (!report.clean) {
          process.exitCode = 1;
          logger.warn("server", "audit-flush-incomplete", JSON.stringify(report));
        }
      } catch (error) {
        process.exitCode = 1;
        logger.warn("server", "audit-flush-failed", String(error));
      }
      process.exit(process.exitCode ?? 0);
    })().catch((error: unknown) => {
      process.exitCode = 1;
      logger.error("server", "shutdown-failed", String(error));
      process.exit(1);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info(
    "server",
    "started",
    `Enhanced Terminal MCP v${VERSION} | safety=${process.env.MCP_SAFETY_MODE || "normal"} | ${getRegisteredToolCount()} tools`,
  );
}

main().catch((e) => {
  // fatal stderr 不回显原始异常文本（可能携带命令/凭据）；栈帧保留定位能力
  const err = redactError(e);
  console.error(`[FATAL] Server crashed: [${err.code}] ${err.message}`);
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
