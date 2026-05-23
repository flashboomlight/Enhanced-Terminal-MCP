/**
 * Token Bucket 限流器 — 防止 LLM 循环中刷爆系统
 * 默认 10 req/s，单用户即足够
 */
import { logger } from "./logger.js";

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly rate: number; // tokens per second
  private readonly capacity: number; // max tokens (burst)
  private readonly refillInterval: number; // ms per token refill

  constructor(ratePerSec = 10, burst = 20) {
    this.rate = ratePerSec;
    this.capacity = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
    this.refillInterval = 1000 / ratePerSec;
  }

  /** 尝试消费 1 个 token，返回是否允许 */
  consume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 尝试消费 n 个 token，返回是否允许 */
  tryConsume(n: number): boolean {
    this.refill();
    return this.tokens >= n;
  }

  /** 实际消费 n 个 token（需先 tryConsume） */
  forceConsume(n: number): void {
    this.tokens = Math.max(0, this.tokens - n);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      const newTokens = elapsed / this.refillInterval;
      this.tokens = Math.min(this.capacity, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  /** 等待直到有足够 token 可用（仅用于 critical path） */
  async waitForTokens(n = 1, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.tryConsume(n)) {
        this.forceConsume(n);
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}

/** 全局单例 — 命令执行限流 */
export const commandRateLimit = new TokenBucket(10, 20);

/** 文件写入限流（低频率） */
export const writeRateLimit = new TokenBucket(5, 10);

/**
 * wrapRateLimit — 速率限制包装器
 * 如果超出限制，返回限流错误
 */
export function checkRateLimit(limiter: TokenBucket, toolName: string): string | null {
  if (!limiter.consume()) {
    logger.warn("rate_limit", toolName, "throttled");
    return `Rate limit exceeded for ${toolName}. Please wait and retry.`;
  }
  return null;
}
