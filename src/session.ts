/**
 * Session 状态管理 — 工作目录、环境上下文
 * 支持工具间上下文传递 + JSON 文件持久化（重启恢复）
 */

import * as fs from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { logger } from "./logger.js";

export interface SessionState {
  cwd: string;
  env: Record<string, string>;
  history: string[]; // 最近执行过的命令
  createdAt: number;
}

const STATE_FILE = path.join(tmpdir(), ".enhanced-terminal-mcp-session.json");

function freshState(): SessionState {
  return { cwd: process.cwd(), env: {}, history: [], createdAt: Date.now() };
}

class SessionStore {
  private state: SessionState = freshState();
  private dirty = false;

  constructor() {
    this.loadFromDisk();
  }

  get(): SessionState {
    return { ...this.state };
  }

  getCwd(): string {
    return this.state.cwd;
  }

  setCwd(cwd: string): void {
    this.state.cwd = cwd;
    this.markDirty();
    logger.info("session", "cwd-changed", cwd);
  }

  setEnv(key: string, value: string): void {
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
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.saveToDisk();
  }

  private async saveToDisk(): Promise<void> {
    try {
      const data = {
        cwd: this.state.cwd,
        env: this.state.env,
        history: this.state.history.slice(-20), // 只保留最近 20 条
        createdAt: this.state.createdAt,
      };
      await fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
      logger.info("session", "persisted", STATE_FILE);
    } catch (e) {
      logger.warn("session", "persist-failed", String(e));
    }
  }

  private loadFromDisk(): void {
    try {
      fs.access(STATE_FILE)
        .then(() => {
          fs.readFile(STATE_FILE, "utf-8")
            .then((raw) => {
              const data = JSON.parse(raw);
              if (data.cwd && typeof data.cwd === "string") this.state.cwd = data.cwd;
              if (data.env && typeof data.env === "object") this.state.env = data.env;
              if (data.history && Array.isArray(data.history)) this.state.history = data.history.slice(-50);
              if (data.createdAt && typeof data.createdAt === "number") this.state.createdAt = data.createdAt;
              logger.info("session", "restored", `cwd=${this.state.cwd}, history=${this.state.history.length}`);
            })
            .catch(() => logger.info("session", "no-prev-session", "starting fresh"));
        })
        .catch(() => {
          /* no previous session file */
        });
    } catch {
      /* ignore */
    }
  }
}

export const session = new SessionStore();
