/**
 * 临时资源基础设施层 — helpers / 环境读取器 / 错误 / 公开接口 / AsyncMutex / ReservationImpl
 *
 * 从 temp-manager.ts 拆出（2026-08-28 structural-debt-cleanup R3）；
 * TempManager 执行器留在 temp-manager.ts 并 re-export 本模块的公开符号。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { envInt } from "./utils.js";

/** 子路径是否真正位于父目录内（防 .. 穿越 / 绝对路径注入） */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 合法子目录 id：非空、无路径分隔符、无 .. */
export function isSafeSubdirId(id: string): boolean {
  if (!id || id.length > 200) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  // 禁止以点开头（隐藏目录）或盘符冒号
  if (id.startsWith(".") || /^[A-Za-z]:/.test(id)) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/** lstat 包装：不存在或失败返回 null */
export async function lstatOrNull(p: string) {
  try {
    return await fs.lstat(p);
  } catch {
    return null;
  }
}

/** readFile 包装：不存在或失败返回 null */
export async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getTempTtlMs(): number {
  return envInt("MCP_TEMP_TTL_MS", 3600000, 1);
}

export function getMaxTempDirs(): number {
  return envInt("MCP_MAX_TEMP_DIRS", 100, 1);
}

export function getCleanupIntervalMs(): number {
  return envInt("MCP_TEMP_CLEANUP_INTERVAL_MS", 300000, 60000);
}

/** temp root 总容量上限；与 command-output 的 limits 默认值一致，两边各自读取 */
export function getMaxTotalBytes(): number {
  return envInt("MCP_TEMP_MAX_TOTAL_BYTES", 1073741824, 1);
}

/** staging heartbeat 间隔与 lease 时长（内部常量，非环境变量） */
export const STAGING_HEARTBEAT_INTERVAL_MS = 30000;
export const STAGING_LEASE_MS = 90000;

/** 容量超限错误：code = temp_capacity_exceeded */
export class TempCapacityExceededError extends Error {
  readonly code = "temp_capacity_exceeded";
  constructor(message: string) {
    super(message);
    this.name = "TempCapacityExceededError";
  }
}

/** 跨进程锁等待超时：code = temp_lock_timeout（调用方负责降级，不无界等待） */
export class TempLockTimeoutError extends Error {
  readonly code = "temp_lock_timeout";
  constructor(message: string) {
    super(message);
    this.name = "TempLockTimeoutError";
  }
}

/** 进程内异步互斥锁：任务链式排队，避免容量核算与清理并发交错 */
export class AsyncMutex {
  private queue: Promise<unknown> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface TempDir {
  id: string;
  dir: string;
  createdAt: number;
  lastAccessedAt: number;
  /** 无受管元数据的未知目录：计入容量但不参与 TTL/LRU 删除 */
  unknown?: boolean;
  /** 发布时使用 meta.json 而非内部 .meta.json（最终 page cache 保持四文件） */
  metadataFile?: "meta.json";
  /** 本进程标记为活跃（如分页读取中），cleanup 跳过 */
  active?: boolean;
}

export interface TempStats {
  total_dirs: number;
  total_size_bytes: number;
  oldest_dir_ms: number;
  newest_dir_ms: number;
  removed_count: number;
  /** 本进程活跃目录数（含 local staging） */
  active_dirs: number;
  /** 活跃 reservation 未写入的预留字节 */
  reserved_bytes: number;
}

/** 容量预留句柄：增量申请、写入记账、释放归还 */
export interface TempReservation {
  readonly id: string;
  readonly reservedBytes: number;
  readonly writtenBytes: number;
  readonly active: boolean;
  reserve(additional: number): Promise<void>;
  markWritten(bytes: number): void;
  release(): Promise<void>;
}

/** staging 句柄：heartbeat 续租、丢弃 */
export interface TempStaging {
  readonly id: string;
  readonly dir: string;
  readonly reservation: TempReservation;
  heartbeat(): Promise<void>;
  discard(): Promise<void>;
}

/** 容量预留实现；核算回调由 TempManager 注入（自带 mutex） */
export class ReservationImpl implements TempReservation {
  reservedBytes = 0;
  writtenBytes = 0;
  active = true;

  constructor(
    readonly id: string,
    private reserveFn: (res: ReservationImpl, additional: number) => Promise<void>,
    private releaseFn: (id: string) => void,
    private invalidateFn: () => void,
  ) {}

  async reserve(additional: number): Promise<void> {
    if (!this.active) throw new Error(`Reservation already released: ${this.id}`);
    if (!Number.isFinite(additional) || additional < 0) {
      throw new Error(`Reservation additional must be a non-negative number, got ${additional}`);
    }
    if (additional === 0) return;
    await this.reserveFn(this, additional);
  }

  markWritten(bytes: number): void {
    if (!this.active) return;
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error(`Reservation written bytes must be a non-negative number, got ${bytes}`);
    }
    this.writtenBytes += bytes;
    // 写入超过预留时按已落盘处理（outstanding 取 max(0, reserved-written)，自然归零）
    if (this.writtenBytes > this.reservedBytes) {
      this.reservedBytes = this.writtenBytes;
    }
    this.invalidateFn();
  }

  async release(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.releaseFn(this.id);
  }

  /** 未写入的预留余量（已写字节由 diskBytes 核算覆盖，避免重复计） */
  outstandingBytes(): number {
    return Math.max(0, this.reservedBytes - this.writtenBytes);
  }
}

/** staging 登记：local=本进程创建（有 reservation 与 heartbeat timer） */
export interface StagingEntry {
  id: string;
  dir: string;
  local: boolean;
  reservation: ReservationImpl | null;
  timer: ReturnType<typeof setInterval> | null;
}
