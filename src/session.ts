/**
 * Session 状态管理 — 工作目录、环境上下文
 * 支持工具间上下文传递 + JSON 文件持久化（重启恢复）
 *
 * 持久化边界（SEC-04）：默认只持久化 env key（不落 value）与 redacted 命令历史；
 * env value 持久化需 MCP_SESSION_PERSIST_ENV_VALUES=1 显式开启，且 denied/sensitive key 永不落盘。
 * env key 判定大小写规范化——Windows 下 path/node_options 小写变体与 PATH/NODE_OPTIONS 等价。
 */

import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import { logger } from "./logger.js";
import { atomicWriteFile } from "./path-policy.js";
import { isDeniedEnvKey, persistentEnvValueAllowed, redactCommand, validateEnvKeyPolicy } from "./secret-governance.js";
import { isForbiddenPath, isSensitivePath, validatePath } from "./security.js";
import { ensureStateDir, ensureStateMigration, getLegacyStateFilePath, getStateFilePath } from "./state-dir.js";

function isSafeEnvKey(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && !k.includes("=") && k.length <= 256;
}

/**
 * 校验从磁盘恢复的 env：键需安全且不在 deny 集合（大小写规范化），值须为字符串
 * 返回过滤后的 env，丢弃一切非法或危险条目
 */
function sanitizeRestoredEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeEnvKey(k) || isDeniedEnvKey(k)) continue;
    if (typeof v !== "string") continue;
    out[k] = v;
  }
  return out;
}

export interface SessionState {
  cwd: string;
  env: Record<string, string>;
  history: string[]; // 最近执行过的命令
  createdAt: number;
}

function freshState(): SessionState {
  return { cwd: process.cwd(), env: {}, history: [], createdAt: Date.now() };
}

/** 导出类便于测试隔离 */
export class SessionStore {
  private state: SessionState = freshState();
  private dirty = false;
  /** 加载完成 promise —— index 启动时 await，确保接受请求前 state 已从磁盘恢复 */
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.loadFromDisk();
    // 抑制 index.ts await 之前间隙的未处理拒绝；错误仍由 await 方（启动流程）处理
    this.loaded.catch(() => {});
  }

  get(): SessionState {
    return { ...this.state };
  }

  getCwd(): string {
    return this.state.cwd;
  }

  setCwd(cwd: string): void {
    const pathErr = validatePath(cwd, "session.setCwd");
    if (pathErr) {
      logger.warn("session", "cwd-rejected", `${cwd} (${pathErr})`);
      throw new Error(pathErr);
    }
    this.state.cwd = cwd;
    this.markDirty();
    logger.info("session", "cwd-changed", cwd);
  }

  setEnv(key: string, value: string): void {
    // validateEnvKeyPolicy：形状 + deny（大小写规范化，path/node_options 变体命中）
    const keyErr = validateEnvKeyPolicy(key);
    if (keyErr) {
      logger.warn("session", "env-key-rejected", key);
      throw new Error(keyErr);
    }
    if (typeof value !== "string") {
      throw new Error("env value must be a string");
    }
    this.state.env[key] = value;
    this.markDirty();
  }

  getEnv(key: string): string | undefined {
    return this.state.env[key];
  }

  pushHistory(command: string): void {
    this.state.history.push(command);
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }
    this.markDirty();
  }

  lastCommand(): string | undefined {
    return this.state.history[this.state.history.length - 1];
  }

  /** 重置到初始状态 */
  reset(): void {
    this.state = freshState();
    this.markDirty();
    logger.info("session", "reset", "session state cleared");
  }

  /** 导出当前状态快照（对象） */
  snapshotObj() {
    return {
      cwd: this.state.cwd,
      envKeys: Object.keys(this.state.env),
      historyLength: this.state.history.length,
      uptimeMinutes: Math.round((Date.now() - this.state.createdAt) / 60000),
    };
  }

  /** 导出当前状态快照（JSON 字符串） */
  snapshot(): string {
    return JSON.stringify(this.snapshotObj(), null, 2);
  }

  /** 保存到磁盘（去抖动 5 秒批量写入） */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.saveToDisk();
    }, 5000);
  }

  /** 立即持久化（关闭时调用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) await this.saveToDisk();
  }

  private async saveToDisk(): Promise<void> {
    try {
      // session.json 是真实产生物：落盘前才确保目录存在（启动/恢复读取不创建）
      await ensureStateDir();
      const stateFile = await getStateFilePath();
      // SEC-04：默认只持久化 env key；value 仅在显式 opt-in 且该 key 允许（非 denied/sensitive）时落盘
      const envKeys = Object.keys(this.state.env);
      const data: Record<string, unknown> = {
        cwd: this.state.cwd,
        envKeys,
        history: this.state.history.slice(-20).map((cmd) => redactCommand(cmd)), // 只保留最近 20 条且经 redactor
        createdAt: this.state.createdAt,
      };
      if (envKeys.some((k) => persistentEnvValueAllowed(k))) {
        const persistedEnv: Record<string, string> = {};
        for (const k of envKeys) {
          if (persistentEnvValueAllowed(k)) persistedEnv[k] = this.state.env[k];
        }
        data.env = persistedEnv;
      }
      // 原子落盘：同目录 exclusive staging + rename，POSIX mode 0o600
      await atomicWriteFile(stateFile, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
      logger.info("session", "persisted", stateFile);
    } catch (e) {
      logger.warn("session", "persist-failed", String(e));
    }
  }

  private async loadFromDisk(): Promise<void> {
    // 4.5：首次使用 session 前完成旧目录迁移；失败（STATE_MIGRATION_FAILED）向上抛，停止启动
    await ensureStateMigration();
    // 全局 TEMP 旧文件不再自动导入/删除，仅提示人工处理（不含内容/cwd/env）
    await this.noteLegacyGlobalFile();
    const stateFile = await getStateFilePath();
    let raw: string;
    try {
      raw = await fs.readFile(stateFile, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        logger.info("session", "no-prev-session", "starting fresh");
        return;
      }
      logger.warn("session", "restore-failed", String(e));
      return;
    }
    this.applyState(raw);
    logger.info("session", "restored", `cwd=${this.state.cwd}, history=${this.state.history.length}`);
  }

  private async noteLegacyGlobalFile(): Promise<void> {
    const legacyFile = getLegacyStateFilePath();
    try {
      await fs.access(legacyFile);
    } catch {
      return;
    }
    logger.info(
      "session",
      "legacy-global-file-present",
      `Legacy session file found at ${legacyFile}; it is no longer auto-imported. Review and remove it manually if needed.`,
    );
  }

  private applyState(raw: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      logger.warn("session", "parse-failed", "starting fresh");
      return;
    }
    // cwd 必须通过路径安全校验（防持久化注入到系统目录），并经 real 解析重验
    // （拒绝 symlink 指向敏感/系统目录或不存在的 cwd）
    if (typeof data.cwd === "string" && data.cwd.trim().length > 0) {
      const pathErr = validatePath(data.cwd, "session.restore:cwd");
      let realOk = false;
      if (!pathErr) {
        try {
          const real = realpathSync(data.cwd);
          realOk = !isForbiddenPath(real) && !isSensitivePath(real);
        } catch {
          realOk = false;
        }
      }
      if (pathErr || !realOk) {
        logger.warn(
          "session",
          "cwd-rejected",
          `Restored cwd rejected by safety: ${data.cwd} (${pathErr ?? "resolves to a forbidden/sensitive path or does not exist"})`,
        );
      } else {
        this.state.cwd = data.cwd;
      }
    }
    // env：legacy env map 经 deny（大小写规范化）+ 类型守卫过滤恢复（防 LD_PRELOAD/NODE_OPTIONS 等注入子进程）；
    // 新格式只有 envKeys（key 仅供排查信息），value 一律不还原、不注入子进程
    if (data.env && typeof data.env === "object" && !Array.isArray(data.env)) {
      this.state.env = sanitizeRestoredEnv(data.env);
    } else {
      this.state.env = {};
    }
    // history 仅保留字符串条目
    if (Array.isArray(data.history)) {
      this.state.history = data.history.filter((h): h is string => typeof h === "string").slice(-50);
    }
    if (typeof data.createdAt === "number" && Number.isFinite(data.createdAt)) {
      this.state.createdAt = data.createdAt;
    }
  }
}

export const session = new SessionStore();
