/**
 * 带 fencing 的文件锁原语（production-hardening #8 / OPS-02）
 *
 * 统一 temp lock 与 migration lock 的 owner / lease heartbeat / fencing token 语义：
 * - 抢占 wx 写 {pid, at, token, fence}；从 stale 锁接管时读旧 fence +1，
 *   经同目录 staging + rename 原子替换（Windows 上 rename 即 REPLACE_EXISTING，无需先 rm）；
 * - stale 判定基于锁内容 at 字段（heartbeat 刷新），而非 mtime；可选用 owner liveness
 *   （process.kill(pid, 0)）对"at 未过期但 owner 已死"的锁立即接管；
 * - 持锁方按 heartbeatMs 周期续租；心跳存活时无论持锁多久都不被接管；
 * - 持锁方可随时 assertFence：锁已被他人接管则抛 LockFenceLostError；
 * - 释放前 token 校验，绝不误删他人锁。
 */

import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { logger } from "./logger.js";

export interface LockInfo {
  pid: number;
  at: number;
  token: string;
  fence: number;
}

export interface AcquiredLock {
  readonly token: string;
  readonly fence: number;
  /** 锁仍属于本持有者则 resolve；已被接管则抛 LockFenceLostError */
  assertFence(): Promise<void>;
}

export interface LockLeaseOptions {
  /** 抢锁等待上限；超时抛 LockLeaseTimeoutError（调用方降级） */
  timeoutMs: number;
  /** heartbeat 缺失多久判定 stale；owner-dead 接管开启时仍作为兜底阈值 */
  staleMs: number;
  /** 持锁续租间隔；0 = 不续租（短事务锁） */
  heartbeatMs: number;
  /** 抢锁轮询间隔 */
  retryMs?: number;
  /** stale 接管观测点（告警/审计） */
  onStale?: (prev: LockInfo | null) => void;
  /** 开启 owner liveness：at 未过期但 owner 进程已死也可接管（migration 场景） */
  takeoverOnDeadOwner?: boolean;
  /** 锁内容损坏（无法解析 owner）时是否允许接管；默认 true。迁移锁应设 false：
   *  无法证明 owner 已死就必须保守 fail-closed，绝不破坏未知锁 */
  takeoverOnCorrupt?: boolean;
  /** owner 存活判定注入点（测试用）；默认 process.kill(pid, 0) */
  isOwnerAlive?: (pid: number) => boolean;
}

export class LockLeaseTimeoutError extends Error {
  readonly code = "lock_lease_timeout";
  constructor(message: string) {
    super(message);
    this.name = "LockLeaseTimeoutError";
  }
}

export class LockFenceLostError extends Error {
  readonly code = "lock_fence_lost";
  constructor(message: string) {
    super(message);
    this.name = "LockFenceLostError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 默认 owner 存活判定：signal 0 探测；ESRCH=已死，EPERM=存在但无权限（视为存活） */
export function defaultOwnerAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** 读取并解析锁文件；不存在返回 null；内容损坏返回 "corrupt" */
async function readLockInfo(lockPath: string): Promise<LockInfo | null | "corrupt"> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    const at = typeof parsed.at === "number" ? parsed.at : Number.NaN;
    const fence = typeof parsed.fence === "number" && Number.isFinite(parsed.fence) ? parsed.fence : 0;
    if (typeof parsed.token !== "string" || !Number.isFinite(at)) return "corrupt";
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      at,
      token: parsed.token,
      fence,
    };
  } catch {
    return "corrupt";
  }
}

/** staging + rename 原子写锁内容（Windows rename 自带替换语义，无需先删旧文件） */
async function atomicWriteLock(lockPath: string, info: LockInfo): Promise<void> {
  const staging = join(
    dirname(lockPath),
    `.${basename(lockPath)}.lease-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    await fs.writeFile(staging, JSON.stringify(info), "utf-8");
    await fs.rename(staging, lockPath);
  } catch (e) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 执行带 fencing 的文件锁事务。
 * fn 收到 AcquiredLock；fn 抛错时锁照常释放；fence 丢失由 assertFence 显式检测。
 */
export async function withFencedLock<T>(
  lockPath: string,
  opts: LockLeaseOptions,
  fn: (lock: AcquiredLock) => Promise<T>,
): Promise<T> {
  const { timeoutMs, staleMs, heartbeatMs } = opts;
  const numericChecks: Array<[string, number]> = [
    ["timeoutMs", timeoutMs],
    ["staleMs", staleMs],
    ["heartbeatMs", heartbeatMs],
  ];
  for (const [name, value] of numericChecks) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Lock ${name} must be a non-negative finite number, got ${value}`);
    }
  }
  const retryMs = opts.retryMs ?? 50;
  const alive = opts.isOwnerAlive ?? defaultOwnerAlive;
  const token = randomToken();
  const deadline = Date.now() + timeoutMs;

  // ---- 抢占 / 接管循环 ----
  let fence = 0;
  let acquired = false;
  while (!acquired) {
    const current = await readLockInfo(lockPath);
    if (current === null) {
      // 空位抢占：fence 从 1 起；EEXIST 说明有人抢先，进入下一轮
      try {
        await atomicWriteLockFresh(lockPath, { pid: process.pid, at: Date.now(), token, fence: 1 });
        fence = 1;
        acquired = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    } else {
      const now = Date.now();
      const prev = current === "corrupt" ? null : current;
      const heartbeatAge = prev ? now - prev.at : Number.POSITIVE_INFINITY;
      const ownerDead = prev !== null && opts.takeoverOnDeadOwner === true && !alive(prev.pid);
      // 接管必须"可证明 stale"：可解析锁看心跳缺失超阈值 / owner 可证已死；
      // 损坏锁（owner 不可知）仅在允许时才接管
      const stale = prev !== null ? heartbeatAge > staleMs || ownerDead : opts.takeoverOnCorrupt !== false;
      if (stale) {
        opts.onStale?.(prev);
        const prevFence = prev?.fence ?? 0;
        try {
          await atomicWriteLock(lockPath, { pid: process.pid, at: now, token, fence: prevFence + 1 });
          fence = prevFence + 1;
          acquired = true;
          break;
        } catch {
          // rename 可能撞上并发接管/读打开的瞬态窗口：清理后重试
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new LockLeaseTimeoutError(`lock lease timeout after ${timeoutMs}ms: ${lockPath}`);
    }
    await sleep(retryMs);
  }

  // ---- 持锁心跳：验证 token 后 staging+rename 续租；发现外来 token 即停跳 ----
  let fenceLost = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      void (async () => {
        const current = await readLockInfo(lockPath);
        if (current === null || current === "corrupt" || current.token !== token) {
          fenceLost = true;
          stopHeartbeat();
          logger.warn("lock-lease", "fence-lost", lockPath);
          return;
        }
        try {
          await atomicWriteLock(lockPath, { ...current, pid: process.pid, at: Date.now(), token });
        } catch {
          // 瞬态写失败（如 rename 窗口）：下一跳续租即可，不中断持锁
        }
      })();
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  const lock: AcquiredLock = {
    token,
    fence,
    assertFence: async () => {
      const current = await readLockInfo(lockPath);
      if (fenceLost || current === null || current === "corrupt" || current.token !== token) {
        throw new LockFenceLostError(`lock fence lost: ${lockPath}`);
      }
    },
  };

  try {
    return await fn(lock);
  } finally {
    stopHeartbeat();
    // token 校验释放：锁已被接管时静默跳过，绝不误删他人锁
    try {
      const current = await readLockInfo(lockPath);
      if (current !== null && current !== "corrupt" && current.token === token) {
        await fs.rm(lockPath, { force: true });
      }
    } catch (e) {
      logger.debug("lock-lease", "release-verify-failed", `${lockPath}: ${String(e)}`);
    }
  }
}

/** 空位抢占专用：wx 语义写入，他人抢先（EEXIST）时失败并保留对方文件 */
async function atomicWriteLockFresh(lockPath: string, info: LockInfo): Promise<void> {
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(JSON.stringify(info), "utf-8");
  } finally {
    await handle.close();
  }
}
