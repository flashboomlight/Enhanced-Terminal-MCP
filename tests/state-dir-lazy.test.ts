/**
 * e2e 回归：干净项目目录启动 server 不创建 .etmcp
 *
 * 对应 issue 2026-08-26-state-dir-eager-creation 的用户报障场景：
 * harness 新开 session（server 启动 + 读 audit 资源）后项目目录必须零创建。
 * 依赖 build/index.js，先执行 pnpm run build。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, test } from "vitest";

const TEST_PARENT = path.resolve(".etmcp/test-tmp/state-dir-lazy-e2e");

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("lazy state dir e2e", () => {
  test("server startup and audit resource read create no .etmcp", async () => {
    const projDir = path.join(TEST_PARENT, `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await fs.mkdir(projDir, { recursive: true });

    const transport = new StdioClientTransport({
      command: "node",
      args: [path.resolve("build/index.js")],
      cwd: projDir,
      env: { ...process.env, MCP_SAFETY_MODE: "off" },
    });
    const client = new Client({ name: "state-dir-lazy-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      // 读 audit://log 资源是纯读路径，不允许创建 .etmcp/logs
      // （资源模板按字面匹配，query 参数不参与，走默认 limit）
      const res = await client.readResource({ uri: "audit://log" });
      expect(res.contents.length).toBeGreaterThan(0);
      const limitedRes = await client.readResource({ uri: "audit://log?limit=5" });
      expect(limitedRes.contents.length).toBeGreaterThan(0);
      // 保守等待异步启动链路（session 恢复、temp cleanup 首轮）完成
      await new Promise((r) => setTimeout(r, 500));
      expect(await dirExists(path.join(projDir, ".etmcp"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  afterAll(async () => {
    await fs.rm(TEST_PARENT, { recursive: true, force: true });
  });
});
