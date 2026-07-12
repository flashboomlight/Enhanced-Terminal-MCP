/**
 * Everything CLI (es.exe) 完整性校验 — 防供应链替换
 * 期望哈希对应仓库内 es_tool/es.exe 的已锁定版本
 */
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/** 仓库锁定的 es.exe SHA-256（更新 es.exe 时必须同步改此常量与测试） */
export const ES_EXE_SHA256 = "5101b3a6d9542de378e077f4b8c66c4e608d3bff088092427749b65fbb18b342";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const ES_EXE_PATH = join(MODULE_DIR, "..", "es_tool", "es.exe");

let verifiedPath: string | null = null;
let verifyPromise: Promise<string | null> | null = null;

/**
 * 校验 es.exe 存在且哈希匹配；通过返回绝对路径，失败返回 null 并打日志
 * 结果缓存：同进程只读盘校验一次
 */
export async function ensureEsExeIntegrity(): Promise<string | null> {
  if (verifiedPath) return verifiedPath;
  if (verifyPromise) return verifyPromise;

  verifyPromise = (async () => {
    try {
      await access(ES_EXE_PATH);
    } catch {
      logger.warn("es-integrity", "missing", ES_EXE_PATH);
      return null;
    }
    try {
      const buf = await readFile(ES_EXE_PATH);
      const hash = createHash("sha256").update(buf).digest("hex");
      if (hash !== ES_EXE_SHA256) {
        logger.error(
          "es-integrity",
          "hash-mismatch",
          `expected ${ES_EXE_SHA256}, got ${hash} — refusing to execute es.exe`,
        );
        return null;
      }
      verifiedPath = ES_EXE_PATH;
      return verifiedPath;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("es-integrity", "read-failed", msg);
      return null;
    }
  })();

  const result = await verifyPromise;
  if (!result) verifyPromise = null; // 允许下次重试（例如文件后补）
  return result;
}

/** 测试用：清除缓存 */
export function resetEsIntegrityCache(): void {
  verifiedPath = null;
  verifyPromise = null;
}
