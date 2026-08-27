/**
 * 分页缓存错误类型 — 独立成模块以便 index-format/paths 子模块引用而不产生循环 import
 *
 * 从 paging.ts 拆出（2026-08-28 structural-debt-cleanup R2）；paging.ts re-export 保持公开 API 不变。
 */

export class PageCacheCorruptError extends Error {
  readonly code = "cache_corrupt";

  constructor(message: string) {
    super(message);
    this.name = "PageCacheCorruptError";
  }
}

export class PageCacheReadError extends Error {
  readonly code: "cache_not_found" | "cache_page_out_of_range" | "cache_invalid_id";
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(
    code: "cache_not_found" | "cache_page_out_of_range" | "cache_invalid_id",
    message: string,
    options: { retryable?: boolean; detail?: unknown } = {},
  ) {
    super(message);
    this.name = "PageCacheReadError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}
