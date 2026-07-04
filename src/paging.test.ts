/**
 * 命令输出分页缓存测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PageCache } from "./paging.js";
import { resetStateDirCache } from "./state-dir.js";

describe("page-cache", () => {
  let originalStateDir: string | undefined;
  let originalTtl: string | undefined;
  let originalMax: string | undefined;
  let tmpStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalTtl = process.env.MCP_TEMP_TTL_MS;
    originalMax = process.env.MCP_MAX_TEMP_DIRS;
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-page-test-"));
    process.env.MCP_STATE_DIR = tmpStateDir;
    process.env.MCP_TEMP_TTL_MS = "100";
    process.env.MCP_MAX_TEMP_DIRS = "100";
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

  test("caches large output and returns first page", async () => {
    const cache = new PageCache();
    const stdout = "a".repeat(5000);
    const entry = await cache.cache("echo big", "/tmp", 0, stdout, "", 2000);
    expect(entry.totalChars).toBe(5000);
    expect(entry.totalPages).toBe(3);

    const page1 = await cache.get(entry.id, 1, 2000);
    expect(page1).not.toBeNull();
    expect(page1?.content).toBe("a".repeat(2000));
    expect(page1?.page).toBe(1);
    expect(page1?.total_pages).toBe(3);
    expect(page1?.total_chars).toBe(5000);
  });

  test("returns correct second page", async () => {
    const cache = new PageCache();
    const stdout = "0123456789".repeat(100); // 1000 chars
    const entry = await cache.cache("echo seq", "/tmp", 0, stdout, "", 300);
    const page2 = await cache.get(entry.id, 2, 300);
    expect(page2?.content).toBe(stdout.slice(300, 600));
    expect(page2?.page).toBe(2);
  });

  test("returns null for out-of-range page", async () => {
    const cache = new PageCache();
    const stdout = "x".repeat(100);
    const entry = await cache.cache("echo small", "/tmp", 0, stdout, "", 50);
    const page3 = await cache.get(entry.id, 3, 50);
    expect(page3).toBeNull();
  });

  test("uses default page size and clamps to max", async () => {
    const cache = new PageCache();
    const stdout = "y".repeat(15000);
    const entry = await cache.cache("echo huge", "/tmp", 0, stdout, "", 50000);
    expect(entry.pageSize).toBe(10000);
    expect(entry.totalPages).toBe(2);
  });

  test("scanById recovers entry after cache miss", async () => {
    const cache1 = new PageCache();
    const stdout = "0123456789".repeat(20);
    const entry = await cache1.cache("echo recover", "/tmp", 0, stdout, "", 50);

    const cache2 = new PageCache();
    const page = await cache2.get(entry.id, 1, 50);
    expect(page).not.toBeNull();
    expect(page?.content).toBe(stdout.slice(0, 50));
  });

  test("get returns null when scanById cannot find entry", async () => {
    const cache = new PageCache();
    const result = await cache.get("non-existent-id", 1);
    expect(result).toBeNull();
  });

  test("save failure is logged and propagated", async () => {
    const cache = new PageCache();
    const entry: any = {
      id: "bad",
      dir: "/__nonexistent__/__bad__",
      stderr: "",
      command: "x",
      cwd: "/tmp",
      exitCode: 0,
      createdAt: 1,
      totalChars: 0,
      pageSize: 10,
      totalPages: 1,
    };
    await expect((cache as any).save(entry, "x")).rejects.toThrow();
  });

  test("loadStdout failure propagates for recovered entry", async () => {
    const cache = new PageCache();
    const stdout = "abc";
    const entry = await cache.cache("echo missing", "/tmp", 0, stdout, "", 10);
    await fs.rm(path.join(entry.dir, "stdout.txt"));

    const cache2 = new PageCache();
    await expect(cache2.get(entry.id, 1)).rejects.toThrow();
  });
});
