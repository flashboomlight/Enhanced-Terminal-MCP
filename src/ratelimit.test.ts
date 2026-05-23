/**
 * Rate limiter unit tests
 */
import { describe, expect, it } from "vitest";
import { checkRateLimit, TokenBucket } from "./ratelimit.js";

describe("TokenBucket", () => {
  it("allows consumption within rate", () => {
    const bucket = new TokenBucket(100, 100); // 100 tokens/s
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(true);
    expect(bucket.available).toBeGreaterThanOrEqual(97);
  });

  it("tryConsume checks availability without consuming", () => {
    const bucket = new TokenBucket(10, 1);
    // After 1 token is consumed, capacity is 1 → only 1 available
    bucket.consume(); // consume the 1 initial token
    expect(bucket.tryConsume(1)).toBe(false); // empty
    expect(bucket.tryConsume(0)).toBe(true); // zero-cost
  });

  it("forceConsume reduces tokens", () => {
    const bucket = new TokenBucket(10, 10);
    bucket.forceConsume(5);
    expect(bucket.available).toBeLessThanOrEqual(5);
  });

  it("refills over time", async () => {
    const bucket = new TokenBucket(100, 5);
    // consume all
    for (let i = 0; i < 5; i++) bucket.consume();
    expect(bucket.tryConsume(1)).toBe(false);
    // wait for refill
    await new Promise((r) => setTimeout(r, 30));
    expect(bucket.tryConsume(1)).toBe(true);
  });

  it("waitForTokens eventually succeeds", async () => {
    const bucket = new TokenBucket(200, 5);
    for (let i = 0; i < 5; i++) bucket.consume();
    const result = await bucket.waitForTokens(1, 200);
    expect(result).toBe(true);
  });

  it("waitForTokens times out", async () => {
    const bucket = new TokenBucket(1, 1);
    bucket.consume(); // empty
    const result = await bucket.waitForTokens(1, 10);
    expect(result).toBe(false);
  });
});

describe("checkRateLimit", () => {
  it("returns null when within limit", () => {
    const bucket = new TokenBucket(100, 100);
    expect(checkRateLimit(bucket, "test")).toBeNull();
  });

  it("returns error when throttled", () => {
    const bucket = new TokenBucket(1, 1);
    bucket.consume(); // empty
    const err = checkRateLimit(bucket, "test");
    expect(err).toBeTruthy();
    expect(err).toContain("Rate limit exceeded");
  });
});
