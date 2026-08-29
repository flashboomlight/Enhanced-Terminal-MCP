/**
 * 统一路径解析策略：读语义 real 解析重验、写语义 no-follow、原子 staging 写、根替换检查。
 * 判定函数全部复用 security.ts，黑名单唯一来源不变；本模块不复制任何黑名单。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { ErrorCode, fail, type ToolResult } from "./result.js";
import { isForbiddenPath, isSensitivePath, validatePath } from "./security.js";

export interface PathResolution {
  /** 原始请求路径 */
  requested: string;
  /** 解析后的真实路径（目标不存在时为父 real + basename 或 resolve 产物） */
  real: string;
  /** 目标在解析时是否存在 */
  existed: boolean;
}

export type PathResolveResult = { ok: true; resolution: PathResolution } | { ok: false; result: ToolResult };

/** 对解析出的 real 重跑 forbidden/sensitive 检查；返回错误消息或 null。 */
function revalidateReal(real: string, operation: string, requested: string): string | null {
  if (isForbiddenPath(real)) {
    return `Operation '${operation}' blocked: path resolves via symlink to a protected system directory: ${requested} -> ${real}`;
  }
  if (isSensitivePath(real)) {
    return `Operation '${operation}' blocked: path resolves via symlink to sensitive data: ${requested} -> ${real}`;
  }
  return null;
}

function forbiddenFail(message: string, param: string, meta?: Record<string, unknown>): ToolResult {
  return fail(ErrorCode.PATH_FORBIDDEN, message, { retryable: false, param, meta });
}

/**
 * 读语义（read/list/info/copy 源）：lexical 校验 → realpath → real 重验。
 * realpath 失败（目标不存在）时放行给后续操作的天然 ENOENT，错误契约不变。
 */
export async function resolveForRead(
  targetPath: string,
  operation: string,
  param: string,
  meta?: Record<string, unknown>,
): Promise<PathResolveResult> {
  const pathErr = validatePath(targetPath, operation);
  if (pathErr) return { ok: false, result: forbiddenFail(pathErr, param, meta) };

  let real: string;
  try {
    real = await fs.realpath(targetPath);
  } catch {
    // 不存在 —— 交给实际操作的 ENOENT（与既有 validateRealPath 语义一致）
    return { ok: true, resolution: { requested: targetPath, real: targetPath, existed: false } };
  }
  const realErr = revalidateReal(real, operation, targetPath);
  if (realErr) return { ok: false, result: forbiddenFail(realErr, param, meta) };
  return { ok: true, resolution: { requested: targetPath, real, existed: true } };
}

/**
 * 写语义（write/delete/move 目标）：目标本身是 symlink 直接拒绝（no-follow）；
 * 存在则 realpath 重验；不存在则沿祖先链向上找最近存在的祖先做 real 重验，
 * real 取祖先 real + 剩余段（防止深层缺失路径经 symlink 祖先穿透进敏感/系统目录）。
 */
export async function resolveForWrite(
  targetPath: string,
  operation: string,
  param: string,
  meta?: Record<string, unknown>,
): Promise<PathResolveResult> {
  const pathErr = validatePath(targetPath, operation);
  if (pathErr) return { ok: false, result: forbiddenFail(pathErr, param, meta) };

  let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    st = await fs.lstat(targetPath);
  } catch {
    st = null;
  }

  if (st?.isSymbolicLink()) {
    return {
      ok: false,
      result: forbiddenFail(
        `Operation '${operation}' blocked: target is a symbolic link (no-follow): ${targetPath}`,
        param,
        meta,
      ),
    };
  }

  if (st) {
    const real = await fs.realpath(targetPath);
    const realErr = revalidateReal(real, operation, targetPath);
    if (realErr) return { ok: false, result: forbiddenFail(realErr, param, meta) };
    return { ok: true, resolution: { requested: targetPath, real, existed: true } };
  }

  // 目标不存在：沿祖先链向上找最近存在的祖先做 real 重验（父目录替换防护推广到
  // 整条链；深层缺失路径经 symlink 祖先也能穿透进敏感/系统目录，必须拦截）；
  // 整条链都不存在时放行给 mkdir recursive 的自然行为
  const parent = path.dirname(targetPath);
  let probe = parent;
  for (;;) {
    let probeReal: string;
    try {
      probeReal = await fs.realpath(probe);
    } catch {
      const upper = path.dirname(probe);
      if (upper === probe) break; // 已到根，整链不存在
      probe = upper;
      continue;
    }
    const probeErr = revalidateReal(probeReal, operation, targetPath);
    if (probeErr) return { ok: false, result: forbiddenFail(probeErr, param, meta) };
    const rest = path.relative(probe, targetPath);
    return {
      ok: true,
      resolution: {
        requested: targetPath,
        real: rest ? path.join(probeReal, rest) : probeReal,
        existed: false,
      },
    };
  }
  return { ok: true, resolution: { requested: targetPath, real: path.resolve(targetPath), existed: false } };
}

/**
 * 原子写：同目录 exclusive staging（wx）+ rename 替换（libuv 在 Windows 使用
 * MOVEFILE_REPLACE_EXISTING，不跟随目标 reparse point）；rename 失败回退
 * truncate 写并告警，任何失败路径清理 staging。
 */
export async function atomicWriteFile(
  realPath: string,
  data: string,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const dir = path.dirname(realPath);
  const staging = path.join(
    dir,
    `.${path.basename(realPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(staging, "wx", 0o600);
    await handle.writeFile(data, encoding);
    await handle.close();
    handle = null;
    try {
      await fs.rename(staging, realPath);
    } catch (renameErr) {
      logger.warn("path-policy", "atomic-rename-fallback", `${String(renameErr)}; falling back to truncate write`);
      await fs.rm(staging, { force: true }).catch(() => {});
      await fs.writeFile(realPath, data, encoding);
    }
  } catch (err) {
    await fs.rm(staging, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * 状态/临时根防替换检查：root 存在但为 symlink 或非目录时抛错
 * （调用方将异常映射为 CONFIG_INVALID 语义拒绝服务）；不存在时放行给懒创建。
 */
export async function assertSafeStateRoot(root: string): Promise<void> {
  let st: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    st = await fs.lstat(root);
  } catch {
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`State root is a symlink or not a directory, refusing to use it: ${root}`);
  }
}
