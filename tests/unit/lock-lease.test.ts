/**
 * lock-lease 单元测试（production-hardening #8 / OPS-02）
 *
 * 覆盖：抢占 fence=1、stale 接管 fence+1、heartbeat 存活不被接管、
 * token 校验释放、fence 丢失检测、corrupt 锁语义、migration 死 owner 接管。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type AcquiredLock, LockFenceLostError, LockLeaseTimeoutError, withFencedLock } from "../../src/lock-lease.js";

describe("lock-lease", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-lock-lease-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const lockPath = () => path.join(tmpDir, "test.lock");

  test("fresh acquire writes fence=1 and releases by removing the lock", async () => {
    const result = await withFencedLock(
      lockPath(),
      { timeoutMs: 1000, staleMs: 60000, heartbeatMs: 0 },
      async (lock) => {
        expect(lock.fence).toBe(1);
        const raw = JSON.parse(await fs.readFile(lockPath(), "utf-8")) as { pid: number; token: string; fence: number };
        expect(raw.pid).toBe(process.pid);
        expect(raw.token).toBe(lock.token);
        expect(raw.fence).toBe(1);
        return "ok";
      },
    );
    expect(result).toBe("ok");
    await expect(fs.access(lockPath())).rejects.toThrow();
  });

  test("second contender times out while the lock is held", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withFencedLock(lockPath(), { timeoutMs: 5000, staleMs: 60000, heartbeatMs: 0 }, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    await expect(
      withFencedLock(lockPath(), { timeoutMs: 150, staleMs: 60000, heartbeatMs: 0 }, async () => "never"),
    ).rejects.toBeInstanceOf(LockLeaseTimeoutError);
    release();
    await held;
  });

  test("stale takeover increments fence and reports prev info", async () => {
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: 1, at: Date.now() - 120000, token: "stale", fence: 7 }),
      "utf-8",
    );
    const seen: Array<unknown> = [];
    const fence = await withFencedLock(
      lockPath(),
      {
        timeoutMs: 1000,
        staleMs: 60000,
        heartbeatMs: 0,
        onStale: (prev) => seen.push(prev),
      },
      async (lock) => lock.fence,
    );
    expect(fence).toBe(8);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ token: "stale", fence: 7 });
  });

  test("live heartbeat prevents takeover regardless of hold duration", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 持锁方每 30ms 续租；竞争方 staleMs=80ms：只要心跳存活就永远不该接管
    const held = withFencedLock(lockPath(), { timeoutMs: 5000, staleMs: 60000, heartbeatMs: 30 }, () => gate);
    await new Promise((r) => setTimeout(r, 80));
    // 心跳至少跳了两轮：锁内容 at 应已刷新到近期
    const raw = JSON.parse(await fs.readFile(lockPath(), "utf-8")) as { at: number };
    expect(Date.now() - raw.at).toBeLessThan(80);
    await expect(
      withFencedLock(lockPath(), { timeoutMs: 120, staleMs: 80, heartbeatMs: 0 }, async () => "never"),
    ).rejects.toBeInstanceOf(LockLeaseTimeoutError);
    release();
    await held;
  });

  test("release never removes another owner's lock", async () => {
    // 持有者 A 阻塞在 fn；A 释放前手工模拟接管者写入新 token
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withFencedLock(lockPath(), { timeoutMs: 5000, staleMs: 60000, heartbeatMs: 0 }, () => gate);
    await new Promise((r) => setTimeout(r, 50));
    await fs.writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now(), token: "takeover", fence: 2 }), "utf-8");
    release();
    await held;
    // 接管者的锁仍完整保留
    const raw = JSON.parse(await fs.readFile(lockPath(), "utf-8")) as { token: string };
    expect(raw.token).toBe("takeover");
  });

  test("assertFence throws LockFenceLostError after takeover", async () => {
    let captured: AcquiredLock | null = null;
    await withFencedLock(lockPath(), { timeoutMs: 1000, staleMs: 60000, heartbeatMs: 0 }, async (lock) => {
      captured = lock;
      // 模拟持锁期间被接管
      await fs.writeFile(lockPath(), JSON.stringify({ pid: 1, at: Date.now(), token: "other", fence: 99 }), "utf-8");
      await expect(lock.assertFence()).rejects.toBeInstanceOf(LockFenceLostError);
    });
    expect(captured).not.toBeNull();
  });

  test("corrupt lock follows takeoverOnCorrupt (default takeover, migration-style deny)", async () => {
    await fs.writeFile(lockPath(), "held", "utf-8");
    // 默认（temp 语义）：corrupt 可接管
    await expect(
      withFencedLock(lockPath(), { timeoutMs: 1000, staleMs: 60000, heartbeatMs: 0 }, async (lock) => lock.fence),
    ).resolves.toBe(1);
    // migration 语义：corrupt 不可接管，等待超时且不破坏未知锁
    await fs.writeFile(lockPath(), "held", "utf-8");
    await expect(
      withFencedLock(
        lockPath(),
        { timeoutMs: 150, staleMs: 60000, heartbeatMs: 0, takeoverOnDeadOwner: true, takeoverOnCorrupt: false },
        async () => "never",
      ),
    ).rejects.toBeInstanceOf(LockLeaseTimeoutError);
    expect(await fs.readFile(lockPath(), "utf-8")).toBe("held");
  });

  test("dead owner is taken over immediately; live owner is never preempted", async () => {
    // owner 已死（ESRCH）：立即接管，fence+1
    await fs.writeFile(lockPath(), JSON.stringify({ pid: 3999999, at: Date.now(), token: "dead", fence: 4 }), "utf-8");
    await expect(
      withFencedLock(
        lockPath(),
        { timeoutMs: 1000, staleMs: 60000, heartbeatMs: 0, takeoverOnDeadOwner: true },
        async (lock) => lock.fence,
      ),
    ).resolves.toBe(5);

    // owner 存活且心跳新鲜：即便开启 dead-owner 接管也不抢占（只能等超时）
    await fs.writeFile(
      lockPath(),
      JSON.stringify({ pid: process.pid, at: Date.now(), token: "alive", fence: 9 }),
      "utf-8",
    );
    await expect(
      withFencedLock(
        lockPath(),
        { timeoutMs: 120, staleMs: 60000, heartbeatMs: 0, takeoverOnDeadOwner: true },
        async () => "never",
      ),
    ).rejects.toBeInstanceOf(LockLeaseTimeoutError);
  });

  test("invalid options are rejected", async () => {
    await expect(
      withFencedLock(lockPath(), { timeoutMs: -1, staleMs: 1000, heartbeatMs: 0 }, async () => "x"),
    ).rejects.toThrow("timeoutMs");
  });
});
