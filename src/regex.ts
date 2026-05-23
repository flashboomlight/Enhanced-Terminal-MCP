/**
 * 正则预编译缓存 — 相同 pattern 复用已编译的 RegExp
 * 避免 grep_content 每次 new RegExp() 的开销
 * 包含 ReDoS 防护：拒绝含嵌套量词的危险模式
 */
import { LRUCache } from "./cache.js";

const regexCache = new LRUCache<RegExp>(256, 300000); // 256 entries, 5min TTL

/**
 * ReDoS 检测：拒绝含嵌套量词的危险模式
 * 检测 (X+)+, (X*)+, (X+)*, (X{n,})+, (?:X+)+ 等
 */
const REDOS_PATTERN = /([+*}])\s*[)]\s*[+*{]|([+*])\s*[+*]/;

export function isUnsafeRegex(pattern: string): boolean {
  return REDOS_PATTERN.test(pattern);
}

/** 获取或创建 RegExp（带缓存 + ReDoS 防护，返回新实例避免 lastIndex 状态泄漏） */
export function getRegex(pattern: string, flags = "gi"): RegExp {
  if (isUnsafeRegex(pattern)) {
    throw new Error(`Regex pattern rejected (potential ReDoS): ${pattern.slice(0, 80)}`);
  }
  const key = `${flags}:${pattern}`;
  const cached = regexCache.get(key);
  if (cached) return new RegExp(cached.value.source, cached.value.flags);
  const re = new RegExp(pattern, flags);
  regexCache.set(key, re);
  return re;
}

export { regexCache };
