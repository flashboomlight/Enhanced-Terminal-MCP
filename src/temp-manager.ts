/**
 * 临时资源管理器 — TTL + LRU 回收
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { getStateDir } from "./state-dir.js";
import { envInt } from "./utils.js";

/** 子路径是否真正位于父目录内（防 .. 穿越 / 绝对路径注入） */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 合法子目录 id：非空、无路径分隔符、无 .. */
function isSafeSubdirId(id: string): boolean {
  if (!id || id.length > 200) return false;
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return false;
  // 禁止以点开头（隐藏目录）或盘符冒号
  if (id.startsWith(".") || /^[A-Za-z]:/.test(id)) return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

function getTempTtlMs(): number {
  return envInt("MCP_TEMP_TTL_MS", 3600000, 1);
}

function getMaxTempDirs(): number {
  return envInt("MCP_MAX_TEMP_DIRS", 100, 1);
}

function getCleanupIntervalMs(): number {
  return envInt("MCP_TEMP_CLEANUP_INTERVAL_MS", 300000, 60000);
}

export interface TempDir {
  id: string;
  dir: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface TempStats {
  total_dirs: number;
  total_size_bytes: number;
  oldest_dir_ms: number;
  newest_dir_ms: number;
  removed_count: number;
}

export class TempManager {
  private root: string | null = null;
  private dirs = new Map<string, TempDir>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private removedCount = 0;
  private tempTtlMs = getTempTtlMs();
  private maxTempDirs = getMaxTempDirs();
  private cleanupIntervalMs = getCleanupIntervalMs();

  async init(): Promise<void> {
    const stateDir = await getStateDir();
    const newRoot = path.join(stateDir, "temp");
    if (this.root === newRoot) return;
    // re-read env each init so tests can override via process.env before first use
    this.tempTtlMs = getTempTtlMs();
    this.maxTempDirs = getMaxTempDirs();
    this.cleanupIntervalMs = getCleanupIntervalMs();
    this.root = newRoot;
    await fs.mkdir(this.root, { recursive: true });
    await this.scan();
    this.startAutoCleanup();
  }

  private async scan(): Promise<void> {
    if (!this.root) return;
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(this.root, entry.name);
        const metaPath = path.join(dir, ".meta.json");
        let meta: Partial<TempDir> = {};
        try {
          const raw = await fs.readFile(metaPath, "utf-8");
          meta = JSON.parse(raw) as Partial<TempDir>;
        } catch (err) {
          logger.debug("temp-manager", "meta-read-failed", String(err));
        }
        const now = Date.now();
        this.dirs.set(entry.name, {
          id: entry.name,
          dir,
          createdAt: meta.createdAt || now,
          lastAccessedAt: meta.lastAccessedAt || now,
        });
      }
    } catch (e) {
      logger.warn("temp-manager", "scan-failed", String(e));
    }
  }

  private async saveMeta(dir: TempDir): Promise<void> {
    const metaPath = path.join(dir.dir, ".meta.json");
    try {
      await fs.writeFile(
        metaPath,
        JSON.stringify({ createdAt: dir.createdAt, lastAccessedAt: dir.lastAccessedAt }),
        "utf-8",
      );
    } catch (e) {
      logger.debug("temp-manager", "meta-save-failed", String(e));
    }
  }

  async create(subtype: string, id?: string): Promise<TempDir> {
    await this.init();
    if (!this.root) throw new Error("TempManager not initialized");
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
    const dirPath = path.join(this.root, dirId);
    // 二次防御：拼接后的 dirPath 必须仍在 root 内
    if (!isInside(this.root, dirPath)) {
      throw new Error(`Rejected temp dir outside root: ${dirPath}`);
    }
    await fs.mkdir(dirPath, { recursive: true });
    const now = Date.now();
    const dir: TempDir = { id: dirId, dir: dirPath, createdAt: now, lastAccessedAt: now };
    this.dirs.set(dirId, dir);
    await this.saveMeta(dir);
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

  async cleanup(): Promise<{ removed: number; remaining: number }> {
    await this.init();
    const now = Date.now();
    const toRemove: string[] = [];
    for (const [id, dir] of this.dirs) {
      if (now - dir.lastAccessedAt > this.tempTtlMs) {
        toRemove.push(id);
      }
    }

    // 如果仍然超过上限，按 LRU 淘汰
    if (this.dirs.size - toRemove.length > this.maxTempDirs) {
      const survivors = Array.from(this.dirs.entries())
        .filter(([id]) => !toRemove.includes(id))
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
      const excess = this.dirs.size - toRemove.length - this.maxTempDirs;
      for (let i = 0; i < excess; i++) {
        toRemove.push(survivors[i][0]);
      }
    }

    for (const id of toRemove) {
      const dir = this.dirs.get(id);
      if (!dir) continue;
      // 防御性检查：绝不在 root 之外递归删除
      if (!this.root || !isInside(this.root, dir.dir)) {
        logger.warn("temp-manager", "cleanup-skip-outside", dir.dir);
        continue;
      }
      try {
        await fs.rm(dir.dir, { recursive: true, force: true });
        this.dirs.delete(id);
        this.removedCount++;
      } catch (e) {
        logger.warn("temp-manager", "remove-failed", `${dir.dir}: ${String(e)}`);
      }
    }

    return { removed: toRemove.length, remaining: this.dirs.size };
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
  }

  async stats(): Promise<TempStats> {
    await this.init();
    let totalSize = 0;
    const now = Date.now();
    let oldest = now;
    let newest = 0;
    for (const dir of this.dirs.values()) {
      totalSize += await this.dirSize(dir.dir);
      if (dir.createdAt < oldest) oldest = dir.createdAt;
      if (dir.createdAt > newest) newest = dir.createdAt;
    }
    return {
      total_dirs: this.dirs.size,
      total_size_bytes: totalSize,
      oldest_dir_ms: this.dirs.size > 0 ? now - oldest : 0,
      newest_dir_ms: this.dirs.size > 0 ? now - newest : 0,
      removed_count: this.removedCount,
    };
  }

  private async dirSize(dir: string): Promise<number> {
    let size = 0;
    let entries: string[] = [];
    try {
      // 递归枚举有上限，防解压产生海量小文件时 temp_stats 卡死
      const walked = await fs.readdir(dir, { withFileTypes: true, recursive: true });
      entries = walked.map((e) => path.join(e.path || dir, e.name));
      if (entries.length > 100000) {
        logger.warn("temp-manager", "dir-size-truncated", `${dir}: ${entries.length} entries, capping stat at 100000`);
        entries = entries.slice(0, 100000);
      }
    } catch (e) {
      logger.debug("temp-manager", "dir-size-failed", String(e));
      return 0;
    }
    for (const full of entries) {
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) size += stat.size;
      } catch (err) {
        logger.debug("temp-manager", "dir-size-stat-failed", String(err));
      }
    }
    return size;
  }
}

export const tempManager = new TempManager();
