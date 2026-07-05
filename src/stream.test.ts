/**
 * stream.ts 单元测试
 */

import { describe, expect, test } from "vitest";
import { quickExec, spawnStream } from "./stream.js";

describe("spawnStream", () => {
  test("captures stdout and exit code", async () => {
    const result = await spawnStream("node", ["-e", "console.log('hello')"]);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.all).toContain("hello");
  });

  test("captures stderr", async () => {
    const result = await spawnStream("node", ["-e", "console.error('err')"]);
    expect(result.stderr.trim()).toBe("err");
    expect(result.all).toContain("[stderr]");
    expect(result.all).toContain("err");
  });

  test("times out long-running command", async () => {
    const result = await spawnStream("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeout: 100 });
    expect(result.timedOut).toBe(true);
  });

  test("truncates output exceeding maxOutput", async () => {
    const result = await spawnStream("node", ["-e", "console.log('x'.repeat(10000))"], { maxOutput: 100 });
    expect(result.stdout).toContain("(TRUNCATED)");
    expect(result.truncated).toBe(true);
  });

  test("caps stderr to 1MB", async () => {
    const result = await spawnStream("node", ["-e", "console.error('x'.repeat(2 * 1024 * 1024))"], {
      timeout: 5000,
      maxOutput: 10 * 1024 * 1024,
    });
    expect(result.stderr.length).toBeLessThanOrEqual(1024 * 1024 + 16);
  });

  test("throws on non-existent command", async () => {
    await expect(spawnStream("nonexistent_command_xyz", [])).rejects.toThrow();
  });
});

describe("quickExec", () => {
  test("runs a simple command", async () => {
    const result = await quickExec("echo q");
    expect(result.stdout.trim()).toBe("q");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("times out long quickExec", async () => {
    const result = await quickExec('node -e "setTimeout(()=>{}, 10000)"', 100);
    expect(result.timedOut).toBe(true);
  });
});
