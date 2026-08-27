/**
 * 状态目录懒创建回归测试 — .etmcp 只在首个真实产生物落盘时创建
 *
 * 对应 issue 2026-08-26-state-dir-eager-creation：
 * 启动/恢复读取/资源读取/展示路径零创建；session 持久化、temp 资源、
 * audit 写入才创建目录。状态目录统一指到项目内 .etmcp/test-tmp（AGENTS 约定）。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditLog } from "../../src/audit.js";
import { SessionStore } from "../../src/session.js";
import { resetStateDirCache } from "../../src/state-dir.js";
import { tempManager } from "../../src/temp-manager.js";

const TEST_PARENT = path.resolve(".etmcp/test-tmp/lazy-state-dir");

let originalStateDir: string | undefined;
let caseRoot: string;

async function dirExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("lazy state dir creation", () => {
  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    // 每个用例独立状态目录，配合 resetStateDirCache 隔离进程级解析缓存
    caseRoot = path.join(TEST_PARENT, `case-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    process.env.MCP_STATE_DIR = caseRoot;
    resetStateDirCache();
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) {
      process.env.MCP_STATE_DIR = originalStateDir;
    } else {
      delete process.env.MCP_STATE_DIR;
    }
    resetStateDirCache();
    tempManager.stopAutoCleanup();
    await fs.rm(TEST_PARENT, { recursive: true, force: true });
  });

  test("session restore does not create the state dir", async () => {
    const store = new SessionStore();
    await store.loaded;
    expect(await dirExists(caseRoot)).toBe(false);
  });

  test("session persist creates the state dir with session.json", async () => {
    const store = new SessionStore();
    await store.loaded;
    store.setEnv("LAZY_TEST_MARKER", "1");
    await store.flush();
    expect(await dirExists(caseRoot)).toBe(true);
    const raw = await fs.readFile(path.join(caseRoot, "session.json"), "utf-8");
    expect(raw).toContain("LAZY_TEST_MARKER");
  });

  test("tempManager init does not create the state dir; create() makes temp/", async () => {
    await tempManager.init();
    expect(await dirExists(caseRoot)).toBe(false);
    const dir = await tempManager.create("lazytest");
    expect(dir.dir.startsWith(path.join(caseRoot, "temp"))).toBe(true);
    expect(await dirExists(path.join(caseRoot, "temp"))).toBe(true);
  });

  test("audit recent()/getLogFilePath() do not create the state dir", async () => {
    const log = new AuditLog();
    expect(await log.recent(5)).toEqual([]);
    const logPath = await log.getLogFilePath();
    expect(logPath).toContain(path.join("logs", "audit.jsonl"));
    expect(await dirExists(caseRoot)).toBe(false);
  });

  test("audit record+flush creates logs/audit.jsonl", async () => {
    const log = new AuditLog();
    log.record({ action: "lazy-test", detail: {}, success: false });
    await log.flush();
    const logPath = await log.getLogFilePath();
    expect(await dirExists(path.dirname(logPath as string))).toBe(true);
    const raw = await fs.readFile(logPath as string, "utf-8");
    expect(raw).toContain("lazy-test");
  });
});
