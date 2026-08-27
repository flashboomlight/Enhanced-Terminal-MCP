/**
 * Session 状态管理 — 工作目录、环境上下文
 * 支持工具间上下文传递 + JSON 文件持久化（重启恢复）
 */

import * as fs from "node:fs/promises";
import { logger } from "./logger.js";
import { validatePath } from "./security.js";
import { ensureStateDir, ensureStateMigration, getLegacyStateFilePath, getStateFilePath } from "./state-dir.js";

/**
 * 环境变量注入黑名单 —— 持久化恢复时拒绝这些键
 * 这些变量若被污染会影响所有子进程（spawnStream 合并 session env），
 * 构成持久化提权路径：LD_PRELOAD/NODE_OPTIONS/PATH 劫持等。
 */
const FORBIDDEN_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PSModulePath",
  "SYSTEMROOT",
  "COMSPEC",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

function isSafeEnvKey(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && !k.includes("=") && k.length <= 256;
}

/**
 * 校验从磁盘恢复的 env：键需安全且不在黑名单，值须为字符串
 * 返回过滤后的 env，丢弃一切非法或危险条目
 */
function sanitizeRestoredEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeEnvKey(k) || FORBIDDEN_ENV_KEYS.has(k)) continue;
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
    if (!isSafeEnvKey(key) || FORBIDDEN_ENV_KEYS.has(key)) {
      logger.warn("session", "env-key-rejected", key);
      throw new Error(`Rejected env key: ${key}`);
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
      const data = {
        cwd: this.state.cwd,
        env: this.state.env,
        history: this.state.history.slice(-20), // 只保留最近 20 条
        createdAt: this.state.createdAt,
      };
      const tmpFile = `${stateFile}.tmp`;
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmpFile, stateFile);
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
    // cwd 必须通过路径安全校验（防持久化注入到系统目录）
    if (typeof data.cwd === "string" && data.cwd.trim().length > 0) {
      const pathErr = validatePath(data.cwd, "session.restore:cwd");
      if (pathErr) {
        logger.warn("session", "cwd-rejected", `Restored cwd rejected by safety: ${data.cwd} (${pathErr})`);
      } else {
        this.state.cwd = data.cwd;
      }
    }
    // env 经黑名单 + 类型守卫过滤（防 LD_PRELOAD/NODE_OPTIONS 等注入子进程）
    this.state.env = sanitizeRestoredEnv(data.env);
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
