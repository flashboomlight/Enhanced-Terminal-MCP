/**
 * 临时资源管理器 — TTL + LRU + 容量 reservation + staging lease 事务化回收
 *
 * 基础设施层（helpers/环境读取器/错误/公开接口/AsyncMutex/ReservationImpl）在 temp-core.ts，
 * 本文件只保留 TempManager 执行器与单例；公开 API 经下方 re-export 保持原有 import 路径不变。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { assertSafeStateRoot } from "./path-policy.js";
import { getStateDir } from "./state-dir.js";
import {
  AsyncMutex,
  getCleanupIntervalMs,
  getMaxTempDirs,
  getMaxTotalBytes,
  getTempTtlMs,
  isInside,
  isSafeSubdirId,
  lstatOrNull,
  ReservationImpl,
  readFileOrNull,
  STAGING_HEARTBEAT_INTERVAL_MS,
  STAGING_LEASE_MS,
  type StagingEntry,
  sleep,
  TempCapacityExceededError,
  type TempDir,
  TempLockTimeoutError,
  type TempReservation,
  type TempStaging,
  type TempStats,
} from "./temp-core.js";

export type { TempDir, TempReservation, TempStaging, TempStats } from "./temp-core.js";
export {
  AsyncMutex,
  STAGING_HEARTBEAT_INTERVAL_MS,
  STAGING_LEASE_MS,
  TempCapacityExceededError,
  TempLockTimeoutError,
} from "./temp-core.js";

/** 跨进程锁文件名与 stale 阈值 */
const TEMP_LOCK_FILE = ".temp.lock";
const TEMP_LOCK_STALE_MS = 60000;
const TEMP_LOCK_TIMEOUT_MS = 5000;
const TEMP_LOCK_RETRY_MS = 50;

/** disk 字节数缓存时长，避免容量核算频繁递归遍历 */
const DISK_BYTES_CACHE_MS = 2000;

export class TempManager {
  private root: string | null = null;
  private dirs = new Map<string, TempDir>();
  private stagings = new Map<string, StagingEntry>();
  private reservations = new Map<string, ReservationImpl>();
  private mutex = new AsyncMutex();
  private timer: ReturnType<typeof setInterval> | null = null;
  private removedCount = 0;
  private tempTtlMs = getTempTtlMs();
  private maxTempDirs = getMaxTempDirs();
  private cleanupIntervalMs = getCleanupIntervalMs();
  private diskBytesCache: { at: number; bytes: number } | null = null;

  /**
   * 懒创建：只解析 root 路径，不 mkdir；root 已存在才扫描 + 崩溃恢复。
   * 始终启动 auto cleanup（root 不存在时 cleanup 是零副作用空转）。
   */
  async init(): Promise<void> {
    const stateDir = await getStateDir();
    const newRoot = path.join(stateDir, "temp");
    if (this.root === newRoot) return;
    // re-read env each init so tests can override via process.env before first use
    this.tempTtlMs = getTempTtlMs();
    this.maxTempDirs = getMaxTempDirs();
    this.cleanupIntervalMs = getCleanupIntervalMs();
    this.root = newRoot;
    // root 已存在才扫描恢复，缺失时零副作用
    const st = await lstatOrNull(newRoot);
    if (st?.isDirectory()) {
      await this.scan();
      try {
        await this.withTempLock(async () => {
          await this.recoverStaleStaging();
        }, 1000);
      } catch (e) {
        // 启动恢复失败（如锁被占）不阻塞，留给后续 cleanup
        logger.debug("temp-manager", "init-recover-skipped", String(e));
      }
    }
    this.startAutoCleanup();
  }

  /** 扫描 root：新目录入册；内存已有条目保留内存时间戳；磁盘消失的条目移除 */
  private async scan(): Promise<void> {
    if (!this.root) return;
    let entries: Array<import("node:fs").Dirent<string>> = [];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (e) {
      logger.warn("temp-manager", "scan-failed", String(e));
      return;
    }
    const seen = new Set<string>();
    const seenStaging = new Set<string>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      if (entry.name.startsWith("staging-") || entry.name.startsWith("inflight-page-cache-")) {
        // staging 目录由 recoverStaleStaging 按 lease 判定，不进 dirs
        seenStaging.add(entry.name);
        if (!this.stagings.has(entry.name)) {
          this.stagings.set(entry.name, { id: entry.name, dir, local: false, reservation: null, timer: null });
        }
        continue;
      }
      seen.add(entry.name);
      // 内存状态（touch/active）优先于磁盘 meta，避免 scan 覆盖
      if (this.dirs.has(entry.name)) continue;
      const metaPath = path.join(dir, ".meta.json");
      const pageMetaPath = path.join(dir, "meta.json");
      let meta: Partial<TempDir> = {};
      let metadataFile: "meta.json" | undefined;
      let unknown = false;
      let raw = await readFileOrNull(metaPath);
      if (raw === null && entry.name.startsWith("page-cache-")) {
        // page cache v2 只有四个发布文件，时间字段来自白名单 meta.json
        raw = await readFileOrNull(pageMetaPath);
        if (raw !== null) metadataFile = "meta.json";
      }
      if (raw === null) {
        // 没有受管元数据的目录是未知目录：计容量但不参与 TTL/LRU 删除
        unknown = true;
      } else {
        try {
          meta = JSON.parse(raw) as Partial<TempDir>;
        } catch (err) {
          // 解析失败按已知目录处理（时间字段回退 now），不标 unknown
          logger.debug("temp-manager", "meta-parse-failed", String(err));
        }
      }
      const now = Date.now();
      this.dirs.set(entry.name, {
        id: entry.name,
        dir,
        createdAt: meta.createdAt || now,
        lastAccessedAt: meta.lastAccessedAt || now,
        unknown: unknown || undefined,
        metadataFile,
      });
    }
    // reconcile：磁盘已消失的条目移出内存
    for (const id of this.dirs.keys()) {
      if (!seen.has(id)) this.dirs.delete(id);
    }
    for (const [id, st] of this.stagings) {
      if (!st.local && !seenStaging.has(id)) this.stagings.delete(id);
    }
  }

  /** 崩溃恢复：删除 lease 过期且非本进程活跃的 staging；返回删除数 */
  private async recoverStaleStaging(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const [id, st] of this.stagings) {
      if (st.local) continue;
      let at = 0;
      const raw = await readFileOrNull(path.join(st.dir, ".heartbeat"));
      if (raw !== null) {
        try {
          at = (JSON.parse(raw) as { at?: number }).at || 0;
        } catch (err) {
          logger.debug("temp-manager", "heartbeat-parse-failed", String(err));
        }
      }
      if (at <= 0) {
        // 无 heartbeat：回退看目录 mtime
        const lst = await lstatOrNull(st.dir);
        at = lst?.mtimeMs || 0;
      }
      if (now - at > STAGING_LEASE_MS) {
        if (await this.removeDir(st.dir)) {
          this.stagings.delete(id);
          this.removedCount++;
          removed++;
        }
      }
    }
    return removed;
  }

  /** 删除 root 内目录（防御性 isInside 检查），失败记 warning 并保留条目 */
  private async removeDir(dir: string): Promise<boolean> {
    if (!this.root || !isInside(this.root, dir)) {
      logger.warn("temp-manager", "remove-skip-outside", dir);
      return false;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      this.invalidateDiskBytes();
      return true;
    } catch (e) {
      logger.warn("temp-manager", "remove-failed", `${dir}: ${String(e)}`);
      return false;
    }
  }

  private async saveMeta(dir: TempDir): Promise<void> {
    const filename = dir.metadataFile ?? ".meta.json";
    const metaPath = path.join(dir.dir, filename);
    try {
      let existing: Record<string, unknown> = {};
      if (dir.metadataFile === "meta.json") {
        const raw = await readFileOrNull(metaPath);
        if (raw !== null) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              existing = parsed as Record<string, unknown>;
            }
          } catch (err) {
            logger.debug("temp-manager", "meta-merge-parse-failed", String(err));
          }
        }
      }
      await fs.writeFile(
        metaPath,
        JSON.stringify({ ...existing, createdAt: dir.createdAt, lastAccessedAt: dir.lastAccessedAt }),
        "utf-8",
      );
    } catch (e) {
      logger.debug("temp-manager", "meta-save-failed", String(e));
    }
  }

  /** 首次真实写入前创建 root（懒创建配套；POSIX 0o700，Windows 下 mode 为 no-op） */
  private async ensureRoot(): Promise<string> {
    await this.init();
    if (!this.root) throw new Error("TempManager not initialized");
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await assertSafeStateRoot(this.root);
    return this.root;
  }

  async create(subtype: string, id?: string): Promise<TempDir> {
    const root = await this.ensureRoot();
    let dirId: string;
    if (id) {
      // 外部传入的 id 必须是安全的子目录名，严防 .. 穿越
      if (!isSafeSubdirId(id)) {
        throw new Error(`Rejected unsafe temp dir id: ${id}`);
      }
      dirId = id;
    } else {
      dirId = `${subtype}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    const dirPath = path.join(root, dirId);
    // 二次防御：拼接后的 dirPath 必须仍在 root 内
    if (!isInside(root, dirPath)) {
      throw new Error(`Rejected temp dir outside root: ${dirPath}`);
    }
    await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const dir: TempDir = { id: dirId, dir: dirPath, createdAt: now, lastAccessedAt: now };
    this.dirs.set(dirId, dir);
    await this.saveMeta(dir);
    this.invalidateDiskBytes();
    return dir;
  }

  private touchDirty = false;
  private touchTimer: ReturnType<typeof setTimeout> | null = null;

  /** 更新访问时间；落盘去抖（最多 1s 一次），避免每次翻页都写 meta */
  touch(id: string): void {
    const dir = this.dirs.get(id);
    if (!dir) return;
    dir.lastAccessedAt = Date.now();
    this.touchDirty = true;
    if (this.touchTimer) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      if (!this.touchDirty) return;
      this.touchDirty = false;
      const now = Date.now();
      // 批量落盘所有最近被 touch 的条目（简单实现：保存全部 dirs）
      for (const d of this.dirs.values()) {
        if (now - d.lastAccessedAt < 1000) {
          this.saveMeta(d).catch((e) => logger.debug("temp-manager", "touch-save-failed", String(e)));
        }
      }
    }, 1000);
    this.touchTimer.unref?.();
  }

  /** 创建容量预留（不建 root，disk 按 0 起步核算） */
  async reserve(id: string, initialBytes = 0): Promise<TempReservation> {
    if (!isSafeSubdirId(id)) throw new Error(`Rejected unsafe reservation id: ${id}`);
    if (!Number.isFinite(initialBytes) || initialBytes < 0) {
      throw new Error(`Reservation initial bytes must be a non-negative number, got ${initialBytes}`);
    }
    return this.mutex.runExclusive(async () => {
      if (this.reservations.has(id)) throw new Error(`Reservation already exists: ${id}`);
      const res = this.newReservation(id);
      if (initialBytes > 0) {
        await this.reserveBytesLocked(res, initialBytes);
      } else {
        this.reservations.set(id, res);
      }
      return res;
    });
  }

  private newReservation(id: string): ReservationImpl {
    return new ReservationImpl(
      id,
      (res, additional) => this.reserveBytes(res, additional),
      (rid) => {
        this.reservations.delete(rid);
      },
      () => this.invalidateDiskBytes(),
    );
  }

  /** 独立预留入口：自带 mutex */
  private async reserveBytes(res: ReservationImpl, additional: number): Promise<void> {
    await this.mutex.runExclusive(() => this.reserveBytesLocked(res, additional));
  }

  /** 容量核算（调用方须已持 mutex）：diskBytes + 未写入预留 + additional > 上限 → 拒绝 */
  private async reserveBytesLocked(res: ReservationImpl, additional: number): Promise<void> {
    if (!res.active) throw new Error(`Reservation already released: ${res.id}`);
    const max = getMaxTotalBytes();
    const used = await this.diskBytesCached();
    if (!res.active) throw new Error(`Reservation already released: ${res.id}`);
    let outstanding = 0;
    for (const r of this.reservations.values()) {
      if (r.active) outstanding += r.outstandingBytes();
    }
    if (used + outstanding + additional > max) {
      throw new TempCapacityExceededError(
        `temp capacity exceeded: used=${used} outstanding=${outstanding} additional=${additional} max=${max}`,
      );
    }
    res.reservedBytes += additional;
    this.reservations.set(res.id, res);
  }

  private invalidateDiskBytes(): void {
    this.diskBytesCache = null;
  }

  /** root 磁盘字节数（2s 缓存；create/cleanup/discard 后失效）；root 不存在为 0 */
  private async diskBytesCached(): Promise<number> {
    const now = Date.now();
    if (this.diskBytesCache && now - this.diskBytesCache.at < DISK_BYTES_CACHE_MS) {
      return this.diskBytesCache.bytes;
    }
    let bytes = 0;
    if (this.root) {
      const st = await lstatOrNull(this.root);
      if (st?.isDirectory()) {
        bytes = await this.dirSize(this.root);
      }
    }
    this.diskBytesCache = { at: now, bytes };
    return bytes;
  }

  /**
   * 跨进程短锁：root 下 .temp.lock，wx 抢占；stale(60s) 强制接管；
   * 默认 5s 超时抛 TempLockTimeoutError，调用方负责降级（不无界等待）。
   */
  async withTempLock<T>(fn: () => Promise<T>, options: { timeoutMs?: number } | number = {}): Promise<T> {
    const timeoutMs = typeof options === "number" ? options : (options.timeoutMs ?? TEMP_LOCK_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error(`Temp lock timeout must be a non-negative number, got ${timeoutMs}`);
    }
    const root = await this.ensureRoot();
    const lockPath = path.join(root, TEMP_LOCK_FILE);
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    while (!acquired) {
      try {
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: "wx" });
        acquired = true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw e;
        // 锁已存在：stale 则强制接管
        const st = await lstatOrNull(lockPath);
        if (st && Date.now() - st.mtimeMs > TEMP_LOCK_STALE_MS) {
          await fs
            .rm(lockPath, { force: true })
            .catch((err) => logger.debug("temp-manager", "lock-stale-rm-failed", String(err)));
          continue;
        }
        if (Date.now() >= deadline) {
          throw new TempLockTimeoutError(`temp lock timeout after ${timeoutMs}ms: ${lockPath}`);
        }
        await sleep(TEMP_LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      const current = await readFileOrNull(lockPath);
      if (current !== null) {
        try {
          const owner = JSON.parse(current) as { token?: string };
          if (owner.token === token) {
            await fs.rm(lockPath, { force: true });
          }
        } catch (err) {
          logger.debug("temp-manager", "lock-release-verify-failed", String(err));
        }
      }
    }
  }

  /**
   * 创建 staging 目录：mutex + tempLock 内完成容量核算与建目录；
   * 注册 heartbeat（30s 续租，lease 90s），创建即 active。
   */
  async createStaging(opts: { initialReserve?: number; prefix?: string } = {}): Promise<TempStaging> {
    return this.mutex.runExclusive(async () => {
      return this.withTempLock(async () => {
        const root = await this.ensureRoot();
        this.invalidateDiskBytes();
        const prefix = opts.prefix ?? "staging";
        if (!isSafeSubdirId(prefix) || prefix.startsWith("page-cache-")) {
          throw new Error(`Rejected unsafe staging prefix: ${prefix}`);
        }
        const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const dir = path.join(root, id);
        const reservation = this.newReservation(id);
        const initial = opts.initialReserve ?? 0;
        if (!Number.isFinite(initial) || initial < 0) {
          throw new Error(`Staging initial reserve must be a non-negative number, got ${initial}`);
        }
        try {
          // 先核算容量再建目录，避免超限后残留空目录
          if (initial > 0) await this.reserveBytesLocked(reservation, initial);
          this.reservations.set(id, reservation);
          await fs.mkdir(dir, { recursive: true });
        } catch (e) {
          this.reservations.delete(id);
          reservation.active = false;
          throw e;
        }
        await this.writeHeartbeat(dir);
        const timer = setInterval(() => {
          this.writeHeartbeat(dir).catch((e) => logger.debug("temp-manager", "heartbeat-failed", String(e)));
        }, STAGING_HEARTBEAT_INTERVAL_MS);
        timer.unref?.();
        this.stagings.set(id, { id, dir, local: true, reservation, timer });
        this.invalidateDiskBytes();
        const staging: TempStaging = {
          id,
          dir,
          reservation,
          heartbeat: async () => this.writeHeartbeat(dir),
          discard: async () => this.discardStaging(id),
        };
        return staging;
      });
    });
  }

  /** 写 heartbeat 文件（JSON: {pid, at}）；失败只记 debug，不阻断主流程 */
  private async writeHeartbeat(dir: string): Promise<void> {
    try {
      await fs.writeFile(path.join(dir, ".heartbeat"), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf-8");
    } catch (e) {
      logger.debug("temp-manager", "heartbeat-write-failed", String(e));
    }
  }

  /** 丢弃 staging：在 mutex/短锁内停 heartbeat、释放 reservation、删目录 */
  private async discardStaging(id: string): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.withTempLock(async () => {
        const st = this.stagings.get(id);
        if (!st) return;
        if (st.timer) {
          clearInterval(st.timer);
          st.timer = null;
        }
        const removed = !st.local || (await this.removeDir(st.dir));
        if (!removed) {
          await this.writeHeartbeat(st.dir);
          st.timer = setInterval(() => {
            this.writeHeartbeat(st.dir).catch((e) => logger.debug("temp-manager", "heartbeat-failed", String(e)));
          }, STAGING_HEARTBEAT_INTERVAL_MS);
          st.timer.unref?.();
          return;
        }
        if (st.reservation) {
          await st.reservation.release();
        }
        this.stagings.delete(id);
      });
    });
  }

  /**
   * 发布 staging：锁内停 heartbeat、删 .heartbeat、rename 到最终 id，
   * reservation 释放（字节已落盘，由 diskBytes 接管），迁移进 dirs（TTL 自发布起计）。
   */
  async finalizeStaging(
    staging: TempStaging,
    finalId: string,
    opts: { metadataFile?: "meta.json" } = {},
  ): Promise<TempDir> {
    if (!isSafeSubdirId(finalId)) {
      throw new Error(`Rejected unsafe temp dir id: ${finalId}`);
    }
    return this.mutex.runExclusive(async () => {
      return this.withTempLock(async () => {
        const root = await this.ensureRoot();
        const st = this.stagings.get(staging.id);
        if (!st?.local) {
          throw new Error(`Staging not active or not local: ${staging.id}`);
        }
        const finalDir = path.join(root, finalId);
        if (!isInside(root, finalDir)) {
          throw new Error(`Rejected temp dir outside root: ${finalDir}`);
        }
        if (st.timer) {
          clearInterval(st.timer);
          st.timer = null;
        }
        // 先删 .heartbeat 再 rename，防止最终目录被 recover 误判为 staging
        await fs
          .rm(path.join(st.dir, ".heartbeat"), { force: true })
          .catch((e) => logger.debug("temp-manager", "heartbeat-rm-failed", String(e)));
        try {
          await fs.rename(st.dir, finalDir);
        } catch (e) {
          // rename 失败时恢复 lease，避免 local staging 变成不可恢复的孤儿目录
          await this.writeHeartbeat(st.dir);
          st.timer = setInterval(() => {
            this.writeHeartbeat(st.dir).catch((err) => logger.debug("temp-manager", "heartbeat-failed", String(err)));
          }, STAGING_HEARTBEAT_INTERVAL_MS);
          st.timer.unref?.();
          throw e;
        }
        if (st.reservation) {
          await st.reservation.release();
        }
        this.stagings.delete(staging.id);
        const now = Date.now();
        const dir: TempDir = {
          id: finalId,
          dir: finalDir,
          createdAt: now,
          lastAccessedAt: now,
          metadataFile: opts.metadataFile,
        };
        this.dirs.set(finalId, dir);
        await this.saveMeta(dir);
        this.invalidateDiskBytes();
        return dir;
      });
    });
  }

  /** 标记目录为本进程活跃（cleanup 跳过）；分页读取期间使用 */
  markActive(id: string): void {
    const dir = this.dirs.get(id);
    if (dir) dir.active = true;
  }

  /** 解除活跃标记 */
  unmarkActive(id: string): void {
    const dir = this.dirs.get(id);
    if (dir) dir.active = false;
  }

  /**
   * 固定清理顺序（mutex + tempLock 内，先 scan 刷新 + staging 恢复）：
   * ① 过期 staging（lease）→ ② TTL 过期（非 active 非 unknown）
   * → ③ 数量超限 LRU → ④ 容量超限 LRU（每次删后重算）。
   * 删除失败保留条目记 warning；锁超时降级本轮放弃清理。
   */
  async cleanup(): Promise<{ removed: number; remaining: number }> {
    await this.init();
    if (!this.root) return { removed: 0, remaining: 0 };
    const rootSt = await lstatOrNull(this.root);
    if (!rootSt?.isDirectory()) return { removed: 0, remaining: 0 };
    return this.mutex.runExclusive(async () => {
      try {
        return await this.withTempLock(async () => {
          await this.scan();
          // ① 过期 staging
          let removed = await this.recoverStaleStaging();
          const now = Date.now();
          const toRemove = new Set<string>();
          // ② TTL 过期：跳过 active 与 unknown
          for (const [id, dir] of this.dirs) {
            if (dir.active || dir.unknown) continue;
            if (now - dir.lastAccessedAt > this.tempTtlMs) {
              toRemove.add(id);
            }
          }
          // 可删除候选：受管、非 unknown、非 active、未在 toRemove 中
          const removable = () =>
            Array.from(this.dirs.values()).filter((d) => !d.unknown && !d.active && !toRemove.has(d.id));
          // ③ 数量超限：LRU 淘汰（基数计受管非 unknown，含 active 占位）
          const managedCount = () =>
            Array.from(this.dirs.values()).filter((d) => !d.unknown && !toRemove.has(d.id)).length;
          const excess = managedCount() - this.maxTempDirs;
          if (excess > 0) {
            const lru = removable().sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
            for (let i = 0; i < excess && i < lru.length; i++) {
              toRemove.add(lru[i].id);
            }
          }
          for (const id of toRemove) {
            const dir = this.dirs.get(id);
            if (!dir) continue;
            if (await this.removeDir(dir.dir)) {
              this.dirs.delete(id);
              this.removedCount++;
              removed++;
            }
          }
          // ④ 容量超限：LRU 继续删直到满足（unknown/active 跳过；removeDir 已使缓存失效，每次重算）
          const max = getMaxTotalBytes();
          if ((await this.diskBytesCached()) > max) {
            const lru = Array.from(this.dirs.values())
              .filter((d) => !d.unknown && !d.active)
              .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
            for (const dir of lru) {
              if ((await this.diskBytesCached()) <= max) break;
              if (await this.removeDir(dir.dir)) {
                this.dirs.delete(dir.id);
                this.removedCount++;
                removed++;
              }
            }
          }
          return { removed, remaining: this.dirs.size };
        });
      } catch (e) {
        if (e instanceof TempLockTimeoutError) {
          // 锁超时降级：本轮放弃清理，不误删
          logger.warn("temp-manager", "cleanup-lock-timeout", String(e));
          return { removed: 0, remaining: this.dirs.size };
        }
        throw e;
      }
    });
  }

  private startAutoCleanup(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.cleanup().catch((e) => logger.warn("temp-manager", "auto-cleanup-failed", String(e)));
    }, this.cleanupIntervalMs);
    this.timer.unref?.();
  }

  stopAutoCleanup(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.touchTimer) {
      clearTimeout(this.touchTimer);
      this.touchTimer = null;
    }
    // 顺带停掉本进程所有 staging heartbeat，便于测试与进程退出清理
    for (const st of this.stagings.values()) {
      if (st.timer) clearInterval(st.timer);
      st.timer = null;
    }
  }

  /** 统计：root 不存在时磁盘字段全零；active/reserved 是内存状态如实报告 */
  async stats(): Promise<TempStats> {
    await this.init();
    const now = Date.now();
    let oldest = now;
    let newest = 0;
    let totalSize = 0;
    const rootExists = this.root ? ((await lstatOrNull(this.root))?.isDirectory() ?? false) : false;
    if (rootExists) {
      for (const dir of this.dirs.values()) {
        totalSize += await this.dirSize(dir.dir);
        if (dir.createdAt < oldest) oldest = dir.createdAt;
        if (dir.createdAt > newest) newest = dir.createdAt;
      }
    }
    let activeDirs = 0;
    for (const dir of this.dirs.values()) {
      if (dir.active) activeDirs++;
    }
    for (const st of this.stagings.values()) {
      if (st.local) activeDirs++;
    }
    let reservedBytes = 0;
    for (const r of this.reservations.values()) {
      if (r.active) reservedBytes += r.outstandingBytes();
    }
    return {
      total_dirs: rootExists ? this.dirs.size : 0,
      total_size_bytes: totalSize,
      oldest_dir_ms: rootExists && this.dirs.size > 0 ? now - oldest : 0,
      newest_dir_ms: rootExists && this.dirs.size > 0 ? now - newest : 0,
      removed_count: this.removedCount,
      active_dirs: activeDirs,
      reserved_bytes: reservedBytes,
    };
  }

  private async dirSize(dir: string): Promise<number> {
    let size = 0;
    const pending = [dir];
    let visited = 0;
    while (pending.length > 0 && visited < 100000) {
      const current = pending.pop();
      if (!current) continue;
      let entries: Array<import("node:fs").Dirent<string>> = [];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (e) {
        logger.debug("temp-manager", "dir-size-failed", String(e));
        continue;
      }
      for (const entry of entries) {
        if (visited >= 100000) break;
        visited++;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
        } else if (entry.isFile()) {
          try {
            size += (await fs.stat(full)).size;
          } catch (err) {
            logger.debug("temp-manager", "dir-size-stat-failed", String(err));
          }
        }
      }
    }
    if (pending.length > 0) {
      logger.warn("temp-manager", "dir-size-truncated", `${dir}: reached 100000 entries`);
    }
    return size;
  }
}

export const tempManager = new TempManager();
