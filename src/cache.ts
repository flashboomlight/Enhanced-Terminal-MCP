/**
 * LRU 结果缓存 — 为 idempotent 只读工具提供结果复用
 * 命中时返回缓存结果，过期或容量满时按 LRU 淘汰
 */

/**
 * JSON.stringify replacer：递归排序对象 key，使缓存键对参数键序不敏感
 * MCP 客户端不保证参数对象 key 顺序，未归一化会导致同参数不同键序缓存 miss
 */
function stableKeySorter(this: unknown, _key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

type CacheEntry<T> = { value: T; expires: number; ttlMs: number; approxBytes: number };

/** 粗估缓存值占用字节（字符串 / JSON 序列化），失败时按 1KB 计 */
function approxValueBytes(value: unknown): number {
  try {
    if (typeof value === "string") return Buffer.byteLength(value, "utf-8");
    if (value && typeof value === "object" && "content" in (value as object)) {
      // CallToolResult 等：序列化 content 为主
      return Buffer.byteLength(JSON.stringify(value), "utf-8");
    }
    return Buffer.byteLength(JSON.stringify(value), "utf-8");
  } catch {
    return 1024;
  }
}

export class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  /** 近似内存上限（字节）；0 = 不限制 */
  private readonly maxMemoryBytes: number;
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 128, defaultTTLms = 30000, maxMemoryBytes = 32 * 1024 * 1024) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTLms;
    this.maxMemoryBytes = maxMemoryBytes;
  }

  /** 构造缓存键：工具名 + 参数 JSON（键序归一化，对参数对象 key 排序后再 stringify） */
  static key(toolName: string, args: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(args, stableKeySorter)}`;
  }

  get(key: string): { value: T; fromCache: true } | null {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expires) {
      this.totalBytes -= entry.approxBytes;
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    // LRU + 滑动 TTL：命中后刷新过期时间并移到末尾
    this.cache.delete(key);
    entry.expires = Date.now() + entry.ttlMs;
    this.cache.set(key, entry);
    this.hits++;
    return { value: entry.value, fromCache: true };
  }

  set(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTTL;
    const bytes = approxValueBytes(value);
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.approxBytes;
      this.cache.delete(key);
    }
    // 先按条目数 / 内存淘汰
    this.evictIfNeeded(bytes);
    this.cache.set(key, {
      value,
      expires: Date.now() + ttl,
      ttlMs: ttl,
      approxBytes: bytes,
    });
    this.totalBytes += bytes;
  }

  private evictIfNeeded(incomingBytes: number): void {
    const now = Date.now();
    // 优先清过期
    for (const [k, v] of this.cache) {
      if (now > v.expires) {
        this.totalBytes -= v.approxBytes;
        this.cache.delete(k);
      }
    }
    while (
      this.cache.size >= this.maxSize ||
      (this.maxMemoryBytes > 0 && this.totalBytes + incomingBytes > this.maxMemoryBytes)
    ) {
      const first = this.cache.keys().next().value;
      if (!first) break;
      const entry = this.cache.get(first);
      if (entry) this.totalBytes -= entry.approxBytes;
      this.cache.delete(first);
    }
  }

  invalidate(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    this.totalBytes -= entry.approxBytes;
    return this.cache.delete(key);
  }

  /** 按前缀清除（如清除某工具的所有缓存） */
  invalidatePrefix(prefix: string): number {
    let n = 0;
    for (const [key, entry] of this.cache) {
      if (key.startsWith(prefix)) {
        this.totalBytes -= entry.approxBytes;
        this.cache.delete(key);
        n++;
      }
    }
    return n;
  }

  /** 按键中包含的子串清除（如清除包含某路径的所有缓存） */
  invalidateByValue(substring: string): number {
    let n = 0;
    for (const [key, entry] of this.cache) {
      if (key.includes(substring)) {
        this.totalBytes -= entry.approxBytes;
        this.cache.delete(key);
        n++;
      }
    }
    return n;
  }

  get stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      approxBytes: this.totalBytes,
      maxMemoryBytes: this.maxMemoryBytes,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? `${((this.hits / (this.hits + this.misses)) * 100).toFixed(1)}%` : "N/A",
    };
  }

  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * 全局工具结果缓存实例
 * 只缓存 idempotent read-only 工具的结果
 */
export const toolCache = new LRUCache<CallToolResult>(128, 30000);

/**
 * 可缓存的工具列表
 * 约束：只能含 readOnlyHint=true 的只读工具。禁止加入 write_file / make_directory /
 * copy_move / delete_path / execute_command 等有副作用的工具 —— 它们即便标了
 * idempotentHint，append 等模式也会因缓存命中跳过实际执行。
 * environment_vars 不缓存（SEC-04）：任意 env 值不得进入共享结果缓存。
 */
export const CACHEABLE_TOOLS = new Set([
  "read_file",
  "file_info",
  "list_directory",
  "get_system_info",
  "search_files",
  "grep_content",
]);

/** 工具级 TTL 覆盖（毫秒），未列出的使用默认 30s */
export const TOOL_TTL: Record<string, number> = {
  list_directory: 5000, // 目录内容变化频繁，5s
  get_system_info: 60000, // 系统信息变化慢，60s
};
