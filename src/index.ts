#!/usr/bin/env node

// src/index.ts — Enhanced Terminal MCP v3.0.0 入口
// 安全锁 + Resources + Prompts + 结构化日志

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as fs from "fs/promises";
import * as os from "os";
import { z } from "zod";

import { initSafeGuard, getSafetyMode } from "./safeguard.js";
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

// ===== 初始化安全锁（必须在工具注册前） =====
initSafeGuard(server);

// ===== Register all tool groups =====
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

// ===== Prompts: 预定义工作流模板 =====
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
  "Analyze a directory as a project and summarize its structure",
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

// ===== Start server =====
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server", "started",
    `Enhanced Terminal MCP v3.0.0 | safety=${getSafetyMode()} | 21 tools, 1 resource, 2 prompts`);
}

main().catch((err) => {
  console.error("[Enhanced Terminal MCP] Fatal error:", err);
  process.exit(1);
});
