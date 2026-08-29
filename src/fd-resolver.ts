// src/fd-resolver.ts — 非 Windows 平台 search_files 的可选 fd/fdfind 引擎解析
// 信任模型：PATH/包管理器安装的系统二进制（与既有 PATH 直调 grep 同级），无 SHA 锁定；
// 运行期绝不下载、不创建状态目录。对标 Everything 的 M3 可选运行时模式（es-integrity.ts）。
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { logger } from "./logger.js";
import { spawnStream } from "./stream.js";

/** 显式指定 fd 可执行文件的环境变量（fail-closed；对标 ENHANCED_TERMINAL_ES_PATH） */
export const FD_PATH_ENV = "ENHANCED_TERMINAL_FD_PATH";

export type FdSource = "explicit" | "path";

export type FdReason =
  | "explicit_path_missing"
  | "explicit_path_not_absolute"
  | "explicit_path_not_file"
  | "explicit_probe_failed"
  | "fd_not_on_path";

/** 非敏感的解析诊断（不含 PATH/环境变量原值） */
export interface FdDiagnostic {
  reason: FdReason;
  env_name: typeof FD_PATH_ENV;
  download_performed: false;
  source: FdSource;
  path?: string;
  attempted: Array<{ source: FdSource; reason: string }>;
}

export type FdResolution =
  | { available: true; source: FdSource; path: string; version?: string }
  | { available: false; source: FdSource; diagnostic: FdDiagnostic };

export interface ResolveFdOptions {
  /** 环境变量来源（默认 process.env），消费 ENHANCED_TERMINAL_FD_PATH 与 PATH */
  env?: NodeJS.ProcessEnv;
  /** PATH 查找（默认扫描 PATH + access(X_OK)，不 spawn） */
  which?: (name: string) => Promise<string | null>;
  /** 可运行性探测（默认 spawn --version，失败返回 null） */
  probeVersion?: (file: string) => Promise<string | null>;
}

/** 默认 PATH 查找：逐目录 access(X_OK)，返回首个可执行命中 */
async function defaultWhich(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathEnv = env.PATH;
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 该目录无此可执行文件，继续下一目录
    }
  }
  return null;
}

/** 默认可运行性探测：执行 --version，成功返回首行版本串 */
async function defaultProbeVersion(file: string): Promise<string | null> {
  try {
    const result = await spawnStream(file, ["--version"], { timeout: 5000, maxOutput: 4096, kind: "fd-probe" });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return first ?? null;
  } catch {
    return null;
  }
}

function unavailable(
  source: FdSource,
  reason: FdReason,
  attempted: FdDiagnostic["attempted"],
  path?: string,
): FdResolution {
  return {
    available: false,
    source,
    diagnostic: { reason, env_name: FD_PATH_ENV, download_performed: false, source, path, attempted },
  };
}

/** 解析 fd 引擎（纯选择逻辑，候选依赖全部可注入；平台中立，调用点自行决定是否使用） */
async function resolveFdUncached(options: ResolveFdOptions): Promise<FdResolution> {
  const env = options.env ?? process.env;
  const which = options.which ?? ((name: string) => defaultWhich(name, env));
  const probe = options.probeVersion ?? defaultProbeVersion;
  const attempted: FdDiagnostic["attempted"] = [];

  // 显式路径 fail closed：任何失败直接不可用，不继续 PATH 候选
  const explicit = env[FD_PATH_ENV]?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      return unavailable("explicit", "explicit_path_not_absolute", attempted, explicit);
    }
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(explicit);
    } catch {
      return unavailable("explicit", "explicit_path_missing", attempted, explicit);
    }
    if (!stat.isFile()) {
      return unavailable("explicit", "explicit_path_not_file", attempted, explicit);
    }
    const version = await probe(explicit);
    if (!version) {
      return unavailable("explicit", "explicit_probe_failed", attempted, explicit);
    }
    return { available: true, source: "explicit", path: explicit, version };
  }

  // PATH 候选：fd（标准名）→ fdfind（Debian/Ubuntu 包名），探测失败记录后继续
  for (const name of ["fd", "fdfind"] as const) {
    const found = await which(name);
    if (!found) {
      attempted.push({ source: "path", reason: `${name} not on PATH` });
      continue;
    }
    const version = await probe(found);
    if (version) return { available: true, source: "path", path: found, version };
    attempted.push({ source: "path", reason: `${name} version probe failed` });
  }

  return unavailable("path", "fd_not_on_path", attempted);
}

let resolutionPromise: Promise<FdResolution> | null = null;

/**
 * 获取 fd 解析结果（进程级缓存）。
 * 首次解析（成功或失败）后缓存到进程退出；改环境变量/安装 fd 后需重启 server。
 * options 仅在缓存未建立时生效（供测试注入）。
 */
export function resolveFd(options: ResolveFdOptions = {}): Promise<FdResolution> {
  if (!resolutionPromise) {
    resolutionPromise = resolveFdUncached(options).then((resolution) => {
      if (resolution.available) {
        logger.info("fd-resolver", "resolved", `source=${resolution.source} version=${resolution.version ?? "n/a"}`);
      } else {
        logger.debug("fd-resolver", "unavailable", resolution.diagnostic.reason);
      }
      return resolution;
    });
  }
  return resolutionPromise;
}

/** 测试用：清除进程级解析缓存 */
export function resetFdResolverCache(): void {
  resolutionPromise = null;
}
