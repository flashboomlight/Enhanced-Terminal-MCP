/**
 * 正则预编译缓存 — 相同 pattern 复用已编译的 RegExp
 * 避免 grep_content 每次 new RegExp() 的开销
 * 包含 ReDoS 防护：拒绝含嵌套量词的危险模式
 */
import { LRUCache } from "./cache.js";

const regexCache = new LRUCache<RegExp>(256, 300000); // 256 entries, 5min TTL

/**
 * ReDoS 检测：拒绝含已知病态构造的模式
 * 多条规则覆盖不同形态：
 * - 嵌套量词：(X+)+, (X*)+, (X+)*, (X{n,})+
 * - 量词作用于可选/分组：(?:X?){n,}, (X*){n,}, (X+){n,}
 * - 链式重叠量词：a+a+a+（无分组但多重叠加）
 * - 量化捕获组重复：(X)+ 占位，由上面覆盖
 */
const REDOS_PATTERNS: RegExp[] = [
  // 嵌套量词：(X+)+, (X*)+, (X+)*, (X{n,})+ 等 —— 量词紧贴在 ) 两侧
  /[+*}]\s*[)]\s*[+*{]/,
  // 相邻量词：++, **, +*, *+（含可选空格）
  /[+*]\s*[+*]/,
  // 量词作用于含可选/星号的组：(?:a?)+, (a*)+, (?:a?){1,100} 等
  // 特征：组内出现 ? 或 * ，且组后被 + * { 量化
  /\([^)]*[?*][^)]*\)\s*[+*{]/,
  // 链式重叠量词（非分组）：a+a+a+a+$ 这类
  /[+*][^+*\s{(][^+*]*[+*][^+*\s{(][^+*]*[+*]/,
];

/** pattern 长度上限，超长 pattern 拒绝（防构造性攻击） */
const MAX_REGEX_PATTERN_LEN = 200;

export function isUnsafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LEN) return true;
  for (const re of REDOS_PATTERNS) {
    if (re.test(pattern)) return true;
  }
  return false;
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
