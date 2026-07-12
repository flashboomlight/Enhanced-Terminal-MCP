/**
 * Shell 进程预热池 —— 当前未激活，仅保留 stats 供 pool_stats 工具呈现。
 *
 * 历史上这里设计了 acquire()/release() 来复用 keep-alive 子进程避免冷启动开销，
 * 但实际命令执行走 spawnStream 按需 spawn，预热复用从未接入 command.ts。
 * 因此本模块只保留：
 *   - stats()  供 pool_stats 工具读取（返回真实状态：池为空、未激活）
 *   - startSweep()/destroy()  生命周期钩子（index.ts 调用，当前为空操作保留接口）
 *
 * 若未来要激活预热复用：
 *   1. spawn 时用 stdio:"ignore" 避免未读 pipe 阻塞子进程（旧实现的 pipe 泄漏）
 *   2. release 时等 exit 事件并 unref，避免 zombie
 *   3. 评估预热 shell 的状态污染（chcp/环境变量残留）对后续命令的影响
 */
import { logger } from "./logger.js";

interface PoolStats {
  size: number;
  max: number;
  idle: number;
  busy: number;
}

class ProcessPool {
  private maxSize: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxSize = 4) {
    this.maxSize = maxSize;
  }

  /** 池统计 —— 当前预热未激活，返回真实空池状态 */
  get stats(): PoolStats {
    return { size: 0, max: this.maxSize, idle: 0, busy: 0 };
  }

  /** 生命周期钩子 —— 预热未激活时为空操作（保留以兼容 index.ts 调用） */
  startSweep(_intervalMs = 30000): void {
    // 预热未激活，无需定时清理
  }

  destroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    logger.info("pool", "destroyed", "pool inactive, no processes to clean");
  }
}

export const processPool = new ProcessPool(4);
