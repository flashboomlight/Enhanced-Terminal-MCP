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

export class LRUCache<T> {
  private cache = new Map<string, { value: T; expires: number }>();
  private readonly maxSize: number;
  private readonly defaultTTL: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 128, defaultTTLms = 30000) {
    this.maxSize = maxSize;
    this.defaultTTL = defaultTTLms;
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
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    // LRU: 移到末尾（重新插入）
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return { value: entry.value, fromCache: true };
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.cache.size >= this.maxSize) {
      // 优先淘汰已过期条目
      const now = Date.now();
      let evicted = false;
      for (const [k, v] of this.cache) {
        if (now > v.expires) {
          this.cache.delete(k);
          evicted = true;
          break;
        }
      }
      // 若无过期条目，淘汰最旧的（LRU — Map 保持插入顺序）
      if (!evicted) {
        const first = this.cache.keys().next().value;
        if (first) this.cache.delete(first);
      }
    }
    this.cache.set(key, {
      value,
      expires: Date.now() + (ttlMs ?? this.defaultTTL),
    });
  }

  invalidate(key: string): boolean {
    return this.cache.delete(key);
  }

  /** 按前缀清除（如清除某工具的所有缓存） */
  invalidatePrefix(prefix: string): number {
    const toDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) toDelete.push(key);
    }
    for (const key of toDelete) this.cache.delete(key);
    return toDelete.length;
  }

  /** 按键中包含的子串清除（如清除包含某路径的所有缓存） */
  invalidateByValue(substring: string): number {
    const toDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (key.includes(substring)) toDelete.push(key);
    }
    for (const key of toDelete) this.cache.delete(key);
    return toDelete.length;
  }

  get stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0 ? `${((this.hits / (this.hits + this.misses)) * 100).toFixed(1)}%` : "N/A",
    };
  }

  clear(): void {
    this.cache.clear();
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
 */
export const CACHEABLE_TOOLS = new Set([
  "read_file",
  "file_info",
  "list_directory",
  "get_system_info",
  "environment_vars",
  "search_files",
  "grep_content",
]);

/** 工具级 TTL 覆盖（毫秒），未列出的使用默认 30s */
export const TOOL_TTL: Record<string, number> = {
  list_directory: 5000, // 目录内容变化频繁，5s
  get_system_info: 60000, // 系统信息变化慢，60s
};
