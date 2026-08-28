/**
 * LRU cache oversized entry 保护单元测试（production-hardening #8 / G9）
 */

import { describe, expect, test } from "vitest";
import { LRUCache } from "../../src/cache.js";

describe("LRUCache oversized protection", () => {
  test("entries larger than maxEntryBytes are rejected, not force-inserted", () => {
    const cache = new LRUCache<string>(8, 10_000, 1000); // maxEntryBytes = 500
    cache.set("big", "x".repeat(600));
    expect(cache.get("big")).toBeNull();
    expect(cache.stats.oversizedRejected).toBe(1);
    expect(cache.stats.size).toBe(0);
  });

  test("oversized rejection does not evict existing hot entries", () => {
    const cache = new LRUCache<string>(8, 10_000, 1000);
    cache.set("hot", "h".repeat(100));
    cache.set("big", "x".repeat(600));
    expect(cache.get("hot")?.value).toBe("h".repeat(100));
    expect(cache.stats.size).toBe(1);
  });

  test("entries within the cap cache normally and the cap is derived from maxMemoryBytes", () => {
    const cache = new LRUCache<string>(8, 10_000, 1000);
    cache.set("ok", "o".repeat(400));
    expect(cache.get("ok")?.value).toBe("o".repeat(400));
    expect(cache.stats.maxEntryBytes).toBe(500);
    expect(cache.stats.oversizedRejected).toBe(0);
  });
});
