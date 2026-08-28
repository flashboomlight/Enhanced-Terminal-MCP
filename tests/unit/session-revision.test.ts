/**
 * session revision writer 单元测试（production-hardening #8）
 *
 * 覆盖：写盘期间新变更必补写（不丢最新状态）、单飞行链串行、
 * persist 失败的健康面。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SessionStore } from "../../src/session.js";
import { resetStateDirCache } from "../../src/state-dir.js";

describe("session revision writer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-session-rev-"));
    process.env.MCP_STATE_DIR = path.join(tmpDir, "state");
    // session 单例在模块导入时就会缓存状态目录：必须先重置再设 env
    resetStateDirCache();
  });

  afterEach(async () => {
    delete process.env.MCP_STATE_DIR;
    resetStateDirCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const stateFile = () => path.join(tmpDir, "state", "session.json");

  test("a mutation during the write window is re-saved, not lost", async () => {
    const session = new SessionStore();
    await session.loaded;
    session.setCwd(tmpDir);
    // flush() 同步阶段即完成 revision/快照捕获；紧随其后的同步 setEnv 必然
    // 落在"已捕获快照、尚未落盘"的写窗口内（确定性构造，不依赖 IO 时序）
    const flushing = session.flush();
    session.setEnv("DURING_WRITE_KEY", "v1");
    await flushing;
    // 旧实现的缺陷在此暴露：dirty 标记被写后清理，新变更永远不会落盘。
    // 新实现通过 revision 比对安排 100ms 补写。
    await new Promise((r) => setTimeout(r, 400));
    const raw = await fs.readFile(stateFile(), "utf-8");
    expect(raw).toContain("DURING_WRITE_KEY");
    expect(session.health().state).toBe("healthy");
  });

  test("concurrent flush and debounced save serialize; disk holds the latest revision", async () => {
    const session = new SessionStore();
    await session.loaded;
    session.setCwd(tmpDir);
    session.setEnv("A", "1");
    const f1 = session.flush();
    session.setEnv("B", "2");
    const f2 = session.flush();
    await Promise.all([f1, f2]);
    const raw = await fs.readFile(stateFile(), "utf-8");
    const parsed = JSON.parse(raw) as { env?: Record<string, string>; envKeys: string[] };
    expect(parsed.envKeys).toContain("A");
    // 最新 revision 必须已落盘（B 在第一次 flush 开始后才变更）
    expect(parsed.envKeys).toContain("B");
  });

  test("flush is idempotent when nothing is dirty", async () => {
    const session = new SessionStore();
    await session.loaded;
    await expect(session.flush()).resolves.toBeUndefined();
    await expect(fs.access(stateFile())).rejects.toThrow();
  });

  test("persist failure is visible in health and retried on next flush", async () => {
    // MCP_STATE_DIR 指向一个文件：ensureStateDir 必然失败
    const blockingFile = path.join(tmpDir, "blocker");
    await fs.writeFile(blockingFile, "x", "utf-8");
    process.env.MCP_STATE_DIR = blockingFile;
    const session = new SessionStore();
    await session.loaded;
    session.setCwd(tmpDir);
    await session.flush();
    const health = session.health();
    expect(health.state).toBe("degraded");
    expect(health.persistFailures).toBe(1);
    expect(health.dirty).toBe(true);
  });

  test("health returns to healthy after a successful persist", async () => {
    const blockingFile = path.join(tmpDir, "blocker");
    await fs.writeFile(blockingFile, "x", "utf-8");
    process.env.MCP_STATE_DIR = blockingFile;
    const session = new SessionStore();
    await session.loaded;
    session.setCwd(tmpDir);
    await session.flush();
    expect(session.health().state).toBe("degraded");
    // 条件修复后成功持久化 → 恢复 healthy（注意：状态目录是进程级缓存，改 env 后必须重置）
    process.env.MCP_STATE_DIR = path.join(tmpDir, "state");
    resetStateDirCache();
    session.setEnv("RECOVER", "1");
    await session.flush();
    expect(session.health().state).toBe("healthy");
  });
});
