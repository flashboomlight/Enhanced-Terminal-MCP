/**
 * 命令输出分页缓存
 *
 * 将超大 stdout 写入临时目录，支持按 page/pageSize 翻页读取。
 * 缓存目录复用 TempManager，TTL/LRU 自动回收。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { tempManager } from "./temp-manager.js";

const DEFAULT_PAGE_SIZE = 2000;
const MAX_PAGE_SIZE = 10000;

export interface PageCacheEntry {
  id: string;
  dir: string;
  command: string;
  cwd: string;
  exitCode: number;
  stderr: string;
  createdAt: number;
  totalChars: number;
  pageSize: number;
  totalPages: number;
}

export interface PageResult {
  content: string;
  page: number;
  total_pages: number;
  page_size: number;
  total_chars: number;
}

export class PageCache {
  private entries = new Map<string, PageCacheEntry>();

  async cache(
    command: string,
    cwd: string,
    exitCode: number,
    stdout: string,
    stderr: string,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<PageCacheEntry> {
    const effectivePageSize = Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE));
    const totalChars = stdout.length;
    const totalPages = Math.max(1, Math.ceil(totalChars / effectivePageSize));
    const temp = await tempManager.create("page-cache");
    const entry: PageCacheEntry = {
      id: temp.id,
      dir: temp.dir,
      command,
      cwd,
      exitCode,
      stderr,
      createdAt: Date.now(),
      totalChars,
      pageSize: effectivePageSize,
      totalPages,
    };
    await this.save(entry, stdout);
    this.entries.set(entry.id, entry);
    return entry;
  }

  private async save(entry: PageCacheEntry, stdout: string): Promise<void> {
    try {
      await fs.writeFile(path.join(entry.dir, "stdout.txt"), stdout, "utf-8");
      await fs.writeFile(path.join(entry.dir, "stderr.txt"), entry.stderr, "utf-8");
      await fs.writeFile(path.join(entry.dir, "meta.json"), JSON.stringify(entry), "utf-8");
    } catch (e) {
      logger.warn("page-cache", "save-failed", String(e));
      throw e;
    }
  }

  private async loadStdout(entry: PageCacheEntry): Promise<string> {
    try {
      return await fs.readFile(path.join(entry.dir, "stdout.txt"), "utf-8");
    } catch (e) {
      logger.warn("page-cache", "load-failed", String(e));
      throw e;
    }
  }

  async get(id: string, page: number, pageSize?: number): Promise<PageResult | null> {
    let entry: PageCacheEntry | undefined = this.entries.get(id);
    if (!entry) {
      entry = (await this.scanById(id)) ?? undefined;
      if (!entry) return null;
    }

    tempManager.touch(id);

    const effectivePageSize = pageSize ? Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE)) : entry.pageSize;
    const totalPages = Math.max(1, Math.ceil(entry.totalChars / effectivePageSize));
    const requestedPage = Math.max(1, page);
    if (requestedPage > totalPages) {
      return null;
    }

    const stdout = await this.loadStdout(entry);
    const start = (requestedPage - 1) * effectivePageSize;
    const content = stdout.slice(start, start + effectivePageSize);
    return {
      content,
      page: requestedPage,
      total_pages: totalPages,
      page_size: effectivePageSize,
      total_chars: entry.totalChars,
    };
  }

  private async scanById(id: string): Promise<PageCacheEntry | null> {
    try {
      const { getStateDir } = await import("./state-dir.js");
      const root = path.join(await getStateDir(), "temp");
      const dir = path.join(root, id);
      const metaPath = path.join(dir, "meta.json");
      const raw = await fs.readFile(metaPath, "utf-8");
      const entry = JSON.parse(raw) as PageCacheEntry;
      entry.dir = dir;
      this.entries.set(id, entry);
      return entry;
    } catch (e) {
      logger.debug("page-cache", "scan-by-id-failed", String(e));
      return null;
    }
  }
}

export const pageCache = new PageCache();
