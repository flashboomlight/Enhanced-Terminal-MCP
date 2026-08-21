/**
 * 临时资源管理器测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetStateDirCache } from "../../src/state-dir.js";
import { STAGING_LEASE_MS, TempManager } from "../../src/temp-manager.js";

describe("temp-manager", () => {
  let originalStateDir: string | undefined;
  let originalTtl: string | undefined;
  let originalMax: string | undefined;
  let originalCleanupInterval: string | undefined;
  let tmpStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalTtl = process.env.MCP_TEMP_TTL_MS;
    originalMax = process.env.MCP_MAX_TEMP_DIRS;
    originalCleanupInterval = process.env.MCP_TEMP_CLEANUP_INTERVAL_MS;
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
    if (originalCleanupInterval !== undefined) process.env.MCP_TEMP_CLEANUP_INTERVAL_MS = originalCleanupInterval;
    else delete process.env.MCP_TEMP_CLEANUP_INTERVAL_MS;
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
    (tm as any).removeDir = async () => false;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await tm.cleanup();
    expect(result.removed).toBe(0);
    expect(result.remaining).toBe(1);
    await fs.rm(dir.dir, { recursive: true, force: true });
  });
});

describe("temp-manager S3 transaction", () => {
  let originalStateDir: string | undefined;
  let originalTtl: string | undefined;
  let originalMax: string | undefined;
  let originalMaxBytes: string | undefined;
  let tmpStateDir: string;
  let managers: TempManager[];

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalTtl = process.env.MCP_TEMP_TTL_MS;
    originalMax = process.env.MCP_MAX_TEMP_DIRS;
    originalMaxBytes = process.env.MCP_TEMP_MAX_TOTAL_BYTES;
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-temp-s3-"));
    managers = [];
    process.env.MCP_STATE_DIR = tmpStateDir;
    process.env.MCP_TEMP_TTL_MS = "100";
    process.env.MCP_MAX_TEMP_DIRS = "2";
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1073741824";
    resetStateDirCache();
  });

  afterEach(async () => {
    for (const manager of managers) manager.stopAutoCleanup();
    if (originalStateDir !== undefined) process.env.MCP_STATE_DIR = originalStateDir;
    else delete process.env.MCP_STATE_DIR;
    if (originalTtl !== undefined) process.env.MCP_TEMP_TTL_MS = originalTtl;
    else delete process.env.MCP_TEMP_TTL_MS;
    if (originalMax !== undefined) process.env.MCP_MAX_TEMP_DIRS = originalMax;
    else delete process.env.MCP_MAX_TEMP_DIRS;
    if (originalMaxBytes !== undefined) process.env.MCP_TEMP_MAX_TOTAL_BYTES = originalMaxBytes;
    else delete process.env.MCP_TEMP_MAX_TOTAL_BYTES;
    resetStateDirCache();
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  function manager(): TempManager {
    const value = new TempManager();
    managers.push(value);
    return value;
  }

  test("init, stats, and cleanup do not create a missing temp root", async () => {
    const tm = manager();
    const root = path.join(tmpStateDir, "temp");
    await tm.init();
    await expect(fs.access(root)).rejects.toThrow();
    await expect(tm.stats()).resolves.toEqual({
      total_dirs: 0,
      total_size_bytes: 0,
      oldest_dir_ms: 0,
      newest_dir_ms: 0,
      removed_count: 0,
      active_dirs: 0,
      reserved_bytes: 0,
    });
    await expect(tm.cleanup()).resolves.toEqual({ removed: 0, remaining: 0 });
    await expect(fs.access(root)).rejects.toThrow();
  });

  test("reservation supports incremental allocation and capacity rejection", async () => {
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1000";
    const tm = manager();
    const reservation = await tm.reserve("r1", 600);
    await reservation.reserve(300);
    expect(reservation.reservedBytes).toBe(900);
    await expect(reservation.reserve(200)).rejects.toMatchObject({ code: "temp_capacity_exceeded" });
    await expect(tm.reserve("r2", 101)).rejects.toMatchObject({ code: "temp_capacity_exceeded" });
  });

  test("markWritten and release return reservation capacity", async () => {
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1000";
    const tm = manager();
    const first = await tm.reserve("first", 800);
    first.markWritten(500);
    expect(first.writtenBytes).toBe(500);
    expect((await tm.stats()).reserved_bytes).toBe(300);
    const second = await tm.reserve("second", 500);
    await first.release();
    expect((await tm.stats()).reserved_bytes).toBe(500);
    const third = await tm.reserve("third", 500);
    expect(third.reservedBytes).toBe(500);
    await second.release();
    await third.release();
  });

  test("reservation accounts for existing disk bytes", async () => {
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1000";
    const tm = manager();
    const dir = await tm.create("data");
    await fs.writeFile(path.join(dir.dir, "data.bin"), Buffer.alloc(800));
    await expect(tm.reserve("too-large", 300)).rejects.toMatchObject({ code: "temp_capacity_exceeded" });
    const allowed = await tm.reserve("allowed", 100);
    expect(allowed.reservedBytes).toBe(100);
    await allowed.release();
  });

  test("withTempLock releases the lock after execution", async () => {
    const tm = manager();
    await tm.create("lock");
    const result = await (tm as any).withTempLock(async () => "ok");
    expect(result).toBe("ok");
    await expect(fs.access(path.join(tmpStateDir, "temp", ".temp.lock"))).rejects.toThrow();
  });

  test("withTempLock times out while another manager holds it", async () => {
    const tm1 = manager();
    const tm2 = manager();
    await tm1.create("lock");
    await tm2.init();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = (tm1 as any).withTempLock(async () => gate);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect((tm2 as any).withTempLock(async () => "unreachable", 200)).rejects.toMatchObject({
      code: "temp_lock_timeout",
    });
    release();
    await held;
  });

  test("withTempLock takes over a stale lock", async () => {
    const tm = manager();
    await tm.create("lock");
    const lockPath = path.join(tmpStateDir, "temp", ".temp.lock");
    await fs.writeFile(lockPath, JSON.stringify({ pid: 1, at: Date.now() - 120000, token: "stale" }));
    const old = new Date(Date.now() - 120000);
    await fs.utimes(lockPath, old, old);
    await expect(tm.withTempLock(async () => "taken")).resolves.toBe("taken");
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  test("createStaging writes heartbeat and tracks active reservation", async () => {
    const tm = manager();
    const staging = await tm.createStaging({ initialReserve: 400 });
    const heartbeatPath = path.join(staging.dir, ".heartbeat");
    const first = JSON.parse(await fs.readFile(heartbeatPath, "utf-8")) as { at: number; pid: number };
    expect(first.pid).toBe(process.pid);
    expect(first.at).toBeGreaterThan(0);
    expect((await tm.stats()).active_dirs).toBe(1);
    expect((await tm.stats()).reserved_bytes).toBe(400);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await staging.heartbeat();
    const second = JSON.parse(await fs.readFile(heartbeatPath, "utf-8")) as { at: number };
    expect(second.at).toBeGreaterThan(first.at);
    await staging.discard();
    expect((await tm.stats()).active_dirs).toBe(0);
    expect((await tm.stats()).reserved_bytes).toBe(0);
    await expect(fs.access(staging.dir)).rejects.toThrow();
  });

  test("init removes staging with an expired heartbeat", async () => {
    const tm1 = manager();
    const staging = await tm1.createStaging();
    tm1.stopAutoCleanup();
    await fs.writeFile(
      path.join(staging.dir, ".heartbeat"),
      JSON.stringify({ pid: 99999, at: Date.now() - STAGING_LEASE_MS - 1000 }),
    );
    const tm2 = manager();
    await tm2.init();
    await expect(fs.access(staging.dir)).rejects.toThrow();
  });

  test("init keeps staging with a fresh heartbeat", async () => {
    const tm1 = manager();
    const staging = await tm1.createStaging();
    const tm2 = manager();
    await tm2.init();
    await expect(fs.access(staging.dir)).resolves.toBeUndefined();
    await staging.discard();
  });

  test("init removes staging without heartbeat by directory mtime", async () => {
    const tm1 = manager();
    await tm1.create("root");
    const ghost = path.join(tmpStateDir, "temp", "staging-ghost");
    await fs.mkdir(ghost);
    const old = new Date(Date.now() - STAGING_LEASE_MS - 1000);
    await fs.utimes(ghost, old, old);
    const tm2 = manager();
    await tm2.init();
    await expect(fs.access(ghost)).rejects.toThrow();
  });

  test("cleanup skips local staging with an expired heartbeat", async () => {
    const tm = manager();
    const staging = await tm.createStaging();
    await fs.writeFile(
      path.join(staging.dir, ".heartbeat"),
      JSON.stringify({ pid: process.pid, at: Date.now() - STAGING_LEASE_MS - 1000 }),
    );
    await expect(tm.cleanup()).resolves.toEqual({ removed: 0, remaining: 0 });
    await expect(fs.access(staging.dir)).resolves.toBeUndefined();
    await staging.discard();
  });

  test("finalizeStaging atomically publishes a four-file-compatible directory", async () => {
    const tm = manager();
    const staging = await tm.createStaging({ initialReserve: 300 });
    await fs.writeFile(path.join(staging.dir, "stdout.bin"), "payload");
    staging.reservation.markWritten(7);
    const final = await tm.finalizeStaging(staging, "page-final");
    expect(final.id).toBe("page-final");
    expect(final.dir).toBe(path.join(tmpStateDir, "temp", "page-final"));
    await expect(fs.readFile(path.join(final.dir, "stdout.bin"), "utf-8")).resolves.toBe("payload");
    await expect(fs.access(path.join(final.dir, ".heartbeat"))).rejects.toThrow();
    expect((await tm.stats()).active_dirs).toBe(0);
    expect((await tm.stats()).reserved_bytes).toBe(0);
    expect((await tm.stats()).total_dirs).toBe(1);
  });

  test("finalizeStaging rejects an unsafe final id and keeps staging usable", async () => {
    const tm = manager();
    const staging = await tm.createStaging();
    await expect(tm.finalizeStaging(staging, "../evil")).rejects.toThrow();
    await expect(fs.access(staging.dir)).resolves.toBeUndefined();
    await staging.discard();
  });

  test("markActive protects a directory until it is unmarked", async () => {
    const tm = manager();
    const dir = await tm.create("active");
    tm.markActive(dir.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(tm.cleanup()).resolves.toEqual({ removed: 0, remaining: 1 });
    await expect(fs.access(dir.dir)).resolves.toBeUndefined();
    tm.unmarkActive(dir.id);
    await expect(tm.cleanup()).resolves.toEqual({ removed: 1, remaining: 0 });
    await expect(fs.access(dir.dir)).rejects.toThrow();
  });

  test("capacity cleanup evicts the oldest managed directory", async () => {
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1500";
    process.env.MCP_TEMP_TTL_MS = "999999999";
    resetStateDirCache();
    const tm = manager();
    const first = await tm.create("first");
    await fs.writeFile(path.join(first.dir, "data.bin"), Buffer.alloc(1000));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await tm.create("second");
    await fs.writeFile(path.join(second.dir, "data.bin"), Buffer.alloc(1000));
    const result = await tm.cleanup();
    expect(result.removed).toBe(1);
    await expect(fs.access(first.dir)).rejects.toThrow();
    await expect(fs.access(second.dir)).resolves.toBeUndefined();
  });

  test("unknown directories count toward capacity but are never evicted", async () => {
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1500";
    process.env.MCP_TEMP_TTL_MS = "999999999";
    resetStateDirCache();
    const tm = manager();
    const known = await tm.create("known");
    const foreign = path.join(tmpStateDir, "temp", "foreign-dir");
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, "data.bin"), Buffer.alloc(1400));
    await fs.writeFile(path.join(known.dir, "data.bin"), Buffer.alloc(100));
    const result = await tm.cleanup();
    expect(result.removed).toBe(1);
    await expect(fs.access(known.dir)).rejects.toThrow();
    await expect(fs.access(foreign)).resolves.toBeUndefined();
  });

  test("touch refreshes TTL and a later idle cleanup removes the directory", async () => {
    const tm = manager();
    const dir = await tm.create("sliding");
    await new Promise((resolve) => setTimeout(resolve, 60));
    tm.touch(dir.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(tm.cleanup()).resolves.toEqual({ removed: 0, remaining: 1 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(tm.cleanup()).resolves.toEqual({ removed: 1, remaining: 0 });
  });

  test("reservation, heartbeat, and cleanup serialize without losing staging", async () => {
    const tm = manager();
    const staging = await tm.createStaging({ initialReserve: 100 });
    const results = await Promise.all([staging.reservation.reserve(50), staging.heartbeat(), tm.cleanup()]);
    expect(results[2]).toEqual({ removed: 0, remaining: 0 });
    expect((await tm.stats()).reserved_bytes).toBe(150);
    await staging.discard();
  });
});
