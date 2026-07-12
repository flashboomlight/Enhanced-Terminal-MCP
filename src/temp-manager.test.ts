/**
 * 临时资源管理器测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetStateDirCache } from "./state-dir.js";
import { TempManager } from "./temp-manager.js";

describe("temp-manager", () => {
  let originalStateDir: string | undefined;
  let originalTtl: string | undefined;
  let originalMax: string | undefined;
  let tmpStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalTtl = process.env.MCP_TEMP_TTL_MS;
    originalMax = process.env.MCP_MAX_TEMP_DIRS;
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-temp-test-"));
    process.env.MCP_STATE_DIR = tmpStateDir;
    process.env.MCP_TEMP_TTL_MS = "100";
    process.env.MCP_MAX_TEMP_DIRS = "2";
    resetStateDirCache();
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) process.env.MCP_STATE_DIR = originalStateDir;
    else delete process.env.MCP_STATE_DIR;
    if (originalTtl !== undefined) process.env.MCP_TEMP_TTL_MS = originalTtl;
    else delete process.env.MCP_TEMP_TTL_MS;
    if (originalMax !== undefined) process.env.MCP_MAX_TEMP_DIRS = originalMax;
    else delete process.env.MCP_MAX_TEMP_DIRS;
    resetStateDirCache();
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  test("create returns temp dir under state temp/", async () => {
    const tm = new TempManager();
    const dir = await tm.create("page-cache");
    expect(dir.dir).toContain(path.join(tmpStateDir, "temp"));
    const stat = await fs.stat(dir.dir);
    expect(stat.isDirectory()).toBe(true);
  });

  test("cleanup removes expired dirs by TTL", async () => {
    const tm = new TempManager();
    const dir = await tm.create("page-cache");
    await fs.writeFile(path.join(dir.dir, "data.txt"), "hello");
    await new Promise((r) => setTimeout(r, 150));
    const result = await tm.cleanup();
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(0);
    await expect(fs.access(dir.dir)).rejects.toThrow();
  });

  test("cleanup removes oldest dirs when exceeding max", async () => {
    const tm = new TempManager();
    const d1 = await tm.create("a");
    await new Promise((r) => setTimeout(r, 10));
    const _d2 = await tm.create("b");
    await new Promise((r) => setTimeout(r, 10));
    const d3 = await tm.create("c");

    const result = await tm.cleanup();
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(2);
    await expect(fs.access(d1.dir)).rejects.toThrow();
    await expect(fs.access(d3.dir)).resolves.toBeUndefined();
  });

  test("auto cleanup runs in background and stops cleanly", async () => {
    process.env.MCP_TEMP_CLEANUP_INTERVAL_MS = "50";
    const tm = new TempManager();
    await tm.create("auto");
    expect((tm as any).timer).not.toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    tm.stopAutoCleanup();
    expect((tm as any).timer).toBeNull();
  });

  test("stats returns aggregate info", async () => {
    const tm = new TempManager();
    const dir = await tm.create("stats");
    await fs.writeFile(path.join(dir.dir, "data.txt"), "hello world");
    const stats = await tm.stats();
    expect(stats.total_dirs).toBe(1);
    expect(stats.total_size_bytes).toBeGreaterThan(0);
    expect(stats.removed_count).toBe(0);
    expect(stats.oldest_dir_ms).toBeGreaterThanOrEqual(0);
    expect(stats.newest_dir_ms).toBeGreaterThanOrEqual(0);
  });

  test("stats handles empty state", async () => {
    const tm = new TempManager();
    const stats = await tm.stats();
    expect(stats.total_dirs).toBe(0);
    expect(stats.total_size_bytes).toBe(0);
    expect(stats.oldest_dir_ms).toBe(0);
    expect(stats.newest_dir_ms).toBe(0);
  });

  test("touch updates last access time", async () => {
    const tm = new TempManager();
    const dir = await tm.create("touch");
    const before = (tm as any).dirs.get(dir.id)?.lastAccessedAt || 0;
    await new Promise((r) => setTimeout(r, 20));
    tm.touch(dir.id);
    const after = (tm as any).dirs.get(dir.id)?.lastAccessedAt || 0;
    expect(after).toBeGreaterThan(before);
  });

  test("scan recovers existing temp dirs", async () => {
    const tm1 = new TempManager();
    const dir = await tm1.create("scan");

    const tm2 = new TempManager();
    await tm2.init();
    expect((tm2 as any).dirs.has(dir.id)).toBe(true);
  });

  test("scan tolerates corrupt .meta.json and falls back to defaults", async () => {
    const tm1 = new TempManager();
    const dir = await tm1.create("corrupt");
    // 写入损坏的 meta.json（非 JSON）
    await fs.writeFile(path.join(dir.dir, ".meta.json"), "{not valid json");

    const tm2 = new TempManager();
    await tm2.init();
    // 损坏 meta 不应崩溃，目录仍被扫描到，createdAt 用默认值
    expect((tm2 as any).dirs.has(dir.id)).toBe(true);
    const entry = (tm2 as any).dirs.get(dir.id);
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.lastAccessedAt).toBeGreaterThan(0);
  });

  test("LRU does not evict when at or below max", async () => {
    // MCP_MAX_TEMP_DIRS=2（beforeEach 设定）
    const tm = new TempManager();
    await tm.create("a");
    await tm.create("b");
    // 恰好 2 个，不超 max，cleanup 不应 LRU 淘汰（仅 TTL 淘汰，TTL=100ms 内不触发）
    const result = await tm.cleanup();
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(2);
  });

  test("LRU evicts least-recently-accessed when exceeding max", async () => {
    // 拉长 TTL 避免 TTL 淘汰干扰 LRU 淘汰断言
    process.env.MCP_TEMP_TTL_MS = "999999999";
    resetStateDirCache();
    // MCP_MAX_TEMP_DIRS=2（beforeEach 设定），创建 3 个制造超限
    const tm = new TempManager();
    const d1 = await tm.create("d1");
    const d2 = await tm.create("d2");
    const d3 = await tm.create("d3");
    // 明确制造 lastAccessedAt 顺序：d1 最新、d2 最旧、d3 居中
    await new Promise((r) => setTimeout(r, 10));
    tm.touch(d3.id);
    await new Promise((r) => setTimeout(r, 10));
    tm.touch(d1.id);
    // lastAccessedAt: d2(创建时) < d3(touch) < d1(touch 最新) → 最旧 d2 被淘汰
    const result = await tm.cleanup();
    expect(result.removed).toBe(1);
    expect(result.remaining).toBe(2);
    await expect(fs.access(d2.dir)).rejects.toThrow();
    await expect(fs.access(d1.dir)).resolves.toBeUndefined();
    await expect(fs.access(d3.dir)).resolves.toBeUndefined();
  });

  test("cleanup handles remove errors gracefully", async () => {
    const tm = new TempManager();
    const dir = await tm.create("locked");
    await fs.writeFile(path.join(dir.dir, "file.txt"), "x");
    // 模拟无法删除：把目录标记为只读（Windows）或直接改名让路径失效
    const renamed = `${dir.dir}-moved`;
    await fs.rename(dir.dir, renamed);
    // 仍让 TempManager 以为该目录存在
    const result = await tm.cleanup();
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(1);
    await fs.rm(renamed, { recursive: true, force: true });
  });
});
