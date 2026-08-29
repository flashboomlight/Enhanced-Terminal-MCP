/**
 * 命令输出分页缓存 v2 测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PageCache, PageCacheCorruptError } from "../../src/paging.js";
import { resetStateDirCache } from "../../src/state-dir.js";

const CACHE_FILES = ["meta.json", "stderr.bin", "stdout.bin", "stdout.idx"];

describe("page-cache v2", () => {
  let originalStateDir: string | undefined;
  let originalTtl: string | undefined;
  let originalMax: string | undefined;
  let tmpStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalTtl = process.env.MCP_TEMP_TTL_MS;
    originalMax = process.env.MCP_MAX_TEMP_DIRS;
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-page-v2-test-"));
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
    // Windows 高负载下，100ms TTL 的异步 sweep/spill 可能在本 rm 的枚举与 rmdir 之间写入条目
    // 导致 ENOTEMPTY；fs.rm 的有界重试（ENOTEMPTY/EBUSY/EPERM 线性退避）消除竞态，
    // 重试耗尽仍会抛出真实错误，不吞错、不无限重试。
    await fs.rm(tmpStateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function filesIn(dir: string): Promise<string[]> {
    return (await fs.readdir(dir)).sort();
  }

  test("publishes exactly four files and returns the first page", async () => {
    const cache = new PageCache();
    const stdout = "a".repeat(5000);
    const entry = await cache.cache("echo big", "/tmp", 0, stdout, "diagnostic", 2000);
    expect(entry.id).toMatch(/^page-cache-\d{13}-[0-9a-f]{32}$/);
    expect(entry.totalChars).toBe(5000);
    expect(entry.totalPages).toBe(3);
    expect(await filesIn(entry.dir)).toEqual(CACHE_FILES);

    const meta = JSON.parse(await fs.readFile(path.join(entry.dir, "meta.json"), "utf-8")) as Record<string, unknown>;
    expect(meta.command).toBeUndefined();
    expect(meta.cwd).toBeUndefined();
    expect(meta.stdout_encoding).toBe("utf8");
    expect(meta.complete).toBe(true);

    const page1 = await cache.get(entry.id, 1, 2000);
    expect(page1?.content).toBe("a".repeat(2000));
    expect(page1?.stderr).toBe("diagnostic");
    expect(page1?.page).toBe(1);
    expect(page1?.total_pages).toBe(3);
  });

  test("reads later pages by range and suppresses stderr after page one", async () => {
    const cache = new PageCache();
    const stdout = "0123456789".repeat(100);
    const entry = await cache.cache("echo seq", "/tmp", 0, stdout, "stderr", 300);
    const page2 = await cache.get(entry.id, 2, 300);
    expect(page2?.content).toBe(stdout.slice(300, 600));
    expect(page2?.stderr).toBe("");
    expect(page2?.stderr_retained_bytes).toBe(Buffer.byteLength("stderr"));
  });

  test("recalculates page boundaries for a changed page size", async () => {
    const cache = new PageCache();
    const stdout = "x".repeat(1000);
    const entry = await cache.cache("echo size", "/tmp", 0, stdout, "", 300);
    const page = await cache.get(entry.id, 2, 400);
    expect(page?.content).toBe(stdout.slice(400, 800));
    expect(page?.total_pages).toBe(3);
  });

  test("counts emoji as one code point and preserves CRLF", async () => {
    const cache = new PageCache();
    const stdout = "A😀\r\nB👩‍💻C";
    const entry = await cache.cache("echo unicode", "/tmp", 0, stdout, "", 3);
    expect(entry.totalChars).toBe(Array.from(stdout).length);
    const page1 = await cache.get(entry.id, 1, 3);
    const page2 = await cache.get(entry.id, 2, 3);
    expect(page1?.content).toBe(Array.from(stdout).slice(0, 3).join(""));
    expect(page2?.content).toBe(Array.from(stdout).slice(3, 6).join(""));
  });

  test("strips UTF-8 BOM from paged content", async () => {
    const cache = new PageCache();
    const stdout = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("中文")]);
    const entry = await cache.cacheBytes(stdout, Buffer.alloc(0), { pageSize: 1 });
    expect(entry.stdoutEncoding).toBe("utf8");
    expect(entry.stdoutDataStart).toBe(3);
    expect((await cache.get(entry.id, 1, 1))?.content).toBe("中");
    expect((await cache.get(entry.id, 2, 1))?.content).toBe("文");
  });

  test("falls back to GBK on Windows for non-UTF-8 output", async () => {
    if (process.platform !== "win32") return;
    const cache = new PageCache();
    const stdout = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    const entry = await cache.cacheBytes(stdout, Buffer.alloc(0), { pageSize: 1 });
    expect(entry.stdoutEncoding).toBe("gbk");
    expect((await cache.get(entry.id, 1, 1))?.content).toBe("中");
    expect((await cache.get(entry.id, 2, 1))?.content).toBe("文");
  });

  test("recovers a v2 cache after a new PageCache instance", async () => {
    const cache1 = new PageCache();
    const stdout = "recover-".repeat(20);
    const entry = await cache1.cache("echo recover", "/tmp", 0, stdout, "", 50);
    const cache2 = new PageCache();
    const page = await cache2.get(entry.id, 1, 50);
    expect(page?.content).toBe(stdout.slice(0, 50));
  });

  test("returns null for invalid, old-format, missing, and out-of-range IDs", async () => {
    const cache = new PageCache();
    await expect(cache.get("non-existent-id", 1)).resolves.toBeNull();
    await expect(cache.get("page-cache-1-../../x", 1)).resolves.toBeNull();
    await expect(cache.get("page-cache-12345678-12345678", 1)).resolves.toBeNull();
    const entry = await cache.cache("echo small", "/tmp", 0, "x".repeat(10), "", 5);
    await expect(cache.get(entry.id, 3, 5)).resolves.toBeNull();
  });

  test("reports corrupted index without falling back to whole-file reads", async () => {
    const cache = new PageCache();
    const entry = await cache.cache("echo corrupt", "/tmp", 0, "hello world", "", 5);
    await fs.writeFile(path.join(entry.dir, "stdout.idx"), Buffer.from("broken"));
    await expect(cache.get(entry.id, 1, 5)).rejects.toBeInstanceOf(PageCacheCorruptError);
  });

  test("rejects file-size mismatch and does not expose a page", async () => {
    const cache = new PageCache();
    const entry = await cache.cache("echo mismatch", "/tmp", 0, "hello", "", 5);
    await fs.appendFile(path.join(entry.dir, "stdout.bin"), "x");
    await expect(cache.get(entry.id, 1, 5)).rejects.toMatchObject({ code: "cache_corrupt" });
  });
});
