/**
 * Shell 进程预热池 — 复用 keep-alive 子进程避免冷启动开销
 *
 * 惰性初始化：不在模块加载时 spawn 进程，仅在首次 acquire() 时按需创建。
 * shutdown 时统一销毁。
 */
import { ChildProcess, spawn } from "child_process";
import { IS_WIN, getShell } from "./platform.js";
import { logger } from "./logger.js";

interface PoolEntry {
  proc: ChildProcess;
  busy: boolean;
  lastActiveAt: number;
  id: number;
}

class ProcessPool {
  private pool: PoolEntry[] = [];
  private overflow: PoolEntry[] = [];
  private maxSize: number;
  private idleTimeout: number;
  private nextId = 1;
  private shell: string;
  private shellArgs: string[];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxSize = 4, idleTimeoutMs = 60000) {
    this.maxSize = maxSize;
    this.idleTimeout = idleTimeoutMs;
    this.shell = getShell();
    this.shellArgs = IS_WIN ? ["/q"] : [];
  }

  /** 获取一个空闲进程，没有则创建 */
  acquire(): PoolEntry {
    const idle = this.pool.find(e => !e.busy);
    if (idle) {
      idle.busy = true;
      return idle;
    }

    if (this.pool.length < this.maxSize) {
      const proc = spawn(this.shell, this.shellArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      proc.on("error", (err) => { logger.warn("pool", "spawn-error", err.message); });
      const entry: PoolEntry = { proc, busy: true, lastActiveAt: Date.now(), id: this.nextId++ };
      this.pool.push(entry);
      logger.info("pool", "spawned", `shell pid=${proc.pid} pool=${this.pool.length}`);
      return entry;
    }

    // 全满：创建临时进程
    const proc = spawn(this.shell, this.shellArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    proc.on("error", (err) => { logger.warn("pool", "spawn-error", err.message); });
    const entry: PoolEntry = { proc, busy: true, lastActiveAt: Date.now(), id: this.nextId++ };
    this.overflow.push(entry);
    logger.warn("pool", "overflow", `pool full (${this.maxSize}), spawned temporary process pid=${proc.pid}`);
    return entry;
  }

  /** 归还进程 */
  release(entry: PoolEntry): void {
    entry.busy = false;
    entry.lastActiveAt = Date.now();
    const idx = this.overflow.indexOf(entry);
    if (idx !== -1) {
      this.overflow.splice(idx, 1);
      try { entry.proc.kill(); } catch {}
    }
  }

  /** 清理空闲超时的进程 */
  sweep(): number {
    const now = Date.now();
    let removed = 0;
    this.pool = this.pool.filter(e => {
      if (!e.busy && now - e.lastActiveAt > this.idleTimeout) {
        try { e.proc.kill(); } catch {}
        removed++;
        return false;
      }
      return true;
    });
    if (removed > 0) logger.info("pool", "swept", `${removed} idle processes`);
    return removed;
  }

  /** 启动定时清理（由 main() 显式调用） */
  startSweep(intervalMs = 30000) {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  /** 全量销毁 */
  destroy(): void {
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
    for (const e of this.pool) { try { e.proc.kill(); } catch {} }
    for (const e of this.overflow) { try { e.proc.kill(); } catch {} }
    this.pool = [];
    this.overflow = [];
    logger.info("pool", "destroyed", "all processes killed");
  }

  get stats() {
    return {
      size: this.pool.length,
      max: this.maxSize,
      idle: this.pool.filter(e => !e.busy).length,
      busy: this.pool.filter(e => e.busy).length,
    };
  }
}

export const processPool = new ProcessPool(4, 60000);
// 注意：不再在模块加载时自动 startSweep()，由 index.ts main() 显式调用
