/**
 * Session 状态管理 — 工作目录、环境上下文
 * 支持工具间上下文传递（如 cd 后后续工具自动感知目录变化）
 */
import { logger } from "./logger.js";

export interface SessionState {
  cwd: string;
  env: Record<string, string>;
  history: string[];   // 最近执行过的命令
  createdAt: number;
}

const DEFAULT_STATE: SessionState = {
  cwd: process.cwd(),
  env: {},
  history: [],
  createdAt: Date.now(),
};

function freshState(): SessionState {
  return { cwd: process.cwd(), env: {}, history: [], createdAt: Date.now() };
}

class SessionStore {
  private state: SessionState = freshState();

  get(): SessionState {
    return { ...this.state };
  }

  getCwd(): string {
    return this.state.cwd;
  }

  setCwd(cwd: string): void {
    // 验证由调用方（index.ts session_state handler）负责
    this.state.cwd = cwd;
    logger.info("session", "cwd-changed", cwd);
  }

  setEnv(key: string, value: string): void {
    this.state.env[key] = value;
  }

  getEnv(key: string): string | undefined {
    return this.state.env[key];
  }

  pushHistory(command: string): void {
    this.state.history.push(command);
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }
  }

  lastCommand(): string | undefined {
    return this.state.history[this.state.history.length - 1];
  }

  /** 重置到初始状态 */
  reset(): void {
    this.state = freshState();
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
}

export const session = new SessionStore();
