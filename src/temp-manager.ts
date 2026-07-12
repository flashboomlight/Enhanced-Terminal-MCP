/**
 * 临时资源管理器 — TTL + LRU 回收
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { getStateDir } from "./state-dir.js";
import { envInt } from "./utils.js";

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
    const dirId = id || `${subtype}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const dirPath = path.join(this.root, dirId);
    await fs.mkdir(dirPath, { recursive: true });
    const now = Date.now();
    const dir: TempDir = { id: dirId, dir: dirPath, createdAt: now, lastAccessedAt: now };
    this.dirs.set(dirId, dir);
    await this.saveMeta(dir);
    return dir;
  }

  touch(id: string): void {
    const dir = this.dirs.get(id);
    if (dir) {
      dir.lastAccessedAt = Date.now();
      this.saveMeta(dir).catch((e) => logger.debug("temp-manager", "touch-save-failed", String(e)));
    }
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
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          try {
            const stat = await fs.stat(path.join(entry.path || dir, entry.name));
            size += stat.size;
          } catch (err) {
            logger.debug("temp-manager", "dir-size-stat-failed", String(err));
          }
        }
      }
    } catch (e) {
      logger.debug("temp-manager", "dir-size-failed", String(e));
    }
    return size;
  }
}

export const tempManager = new TempManager();
