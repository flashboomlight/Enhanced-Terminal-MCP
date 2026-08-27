/**
 * 分页缓存路径安全断言 — root 包含性、数值安全、普通路径与固定四文件校验
 *
 * 从 paging.ts 拆出（2026-08-28 structural-debt-cleanup R2）。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PageCacheCorruptError } from "./errors.js";

const ALLOWED_CACHE_FILES = new Set(["stdout.bin", "stderr.bin", "stdout.idx", "meta.json"]);

/** 子路径是否仍位于固定父目录内 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 不可信输入是否为安全的有限整数 */
export function isSafeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 验证路径指向 root 内的普通目录或文件，拒绝 symlink/reparse 入口 */
export async function assertRegularPath(file: string, kind: "file" | "directory"): Promise<import("node:fs").Stats> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    throw new PageCacheCorruptError(`Missing cache ${kind}: ${String(error)}`);
  }
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new PageCacheCorruptError(`Cache ${kind} is not a regular path: ${file}`);
  }
  return stat;
}

/** 读取固定四文件目录的真实文件名集合 */
export async function assertFourFiles(dir: string): Promise<void> {
  let entries: Array<import("node:fs").Dirent<string>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new PageCacheCorruptError(`Cannot enumerate cache directory: ${String(error)}`);
  }
  if (
    entries.length !== ALLOWED_CACHE_FILES.size ||
    entries.some((entry) => !entry.isFile() || !ALLOWED_CACHE_FILES.has(entry.name))
  ) {
    throw new PageCacheCorruptError("Cache directory must contain exactly four published files");
  }
}
