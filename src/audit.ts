/**
 * 审计日志 — 结构化记录关键操作
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { atomicWriteFile } from "./path-policy.js";
import { redactDetail, sanitizeLogField } from "./secret-governance.js";
import { ensureStateMigration, getStateDir } from "./state-dir.js";
import { envInt } from "./utils.js";

export interface AuditEntry {
  timestamp: string;
  action: string;
  tool?: string;
  detail: Record<string, unknown>;
  success: boolean;
  error?: string;
  sessionId?: string;
}

export type AuditMode = "off" | "errors" | "all";

function getMaxAuditEntries(): number {
  return envInt("MCP_AUDIT_MAX_ENTRIES", 10000, 100);
}

function getAuditMode(): AuditMode {
  const env = (process.env.MCP_AUDIT_MODE || "errors").toLowerCase().trim();
  if (env === "off" || env === "errors" || env === "all") return env;
  logger.warn("audit", "bad-mode", `Unknown MCP_AUDIT_MODE="${env}", using "errors"`);
  return "errors";
}

export class AuditLog {
  private queue: AuditEntry[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private logFilePathPromise: Promise<string> | null = null;

  /** 纯解析审计日志路径：不创建任何目录（读路径与展示路径使用） */
  private async resolveLogFilePath(): Promise<string> {
    if (!this.logFilePathPromise) {
      this.logFilePathPromise = (async () => {
        // 4.5：首次使用 audit 前完成旧目录迁移；失败向上抛（STATE_MIGRATION_FAILED）
        await ensureStateMigration();
        const dir = await getStateDir();
        return path.join(dir, "logs", "audit.jsonl");
      })();
      // 抑制无人再 await 场景的未处理拒绝噪音；错误仍由实际 await 方处理
      this.logFilePathPromise.catch(() => {});
    }
    return this.logFilePathPromise;
  }

  /** 写路径专用：audit 条目即将落盘，确保 logs 目录存在（POSIX 0o700）后返回路径 */
  private async ensureLogFilePath(): Promise<string> {
    const logFile = await this.resolveLogFilePath();
    await fs.mkdir(path.dirname(logFile), { recursive: true, mode: 0o700 });
    return logFile;
  }

  private shouldRecord(success: boolean): boolean {
    const mode = getAuditMode();
    if (mode === "off") return false;
    if (mode === "all") return true;
    return !success; // errors
  }

  record(entry: Omit<AuditEntry, "timestamp">): void {
    if (!this.shouldRecord(entry.success)) return;
    // 入队前完成净化：secret 原文/原始命令不以未脱敏形态进入内存队列或落盘
    this.queue.push({
      ...entry,
      timestamp: new Date().toISOString(),
      detail: redactDetail(entry.detail) as Record<string, unknown>,
      error: entry.error !== undefined ? sanitizeLogField(entry.error) : undefined,
    });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((e) => logger.warn("audit", "flush-error", String(e)));
    }, 1000);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const entries = this.queue.splice(0);
    if (entries.length === 0) return;
    try {
      const logFile = await this.ensureLogFilePath();
      const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      await fs.appendFile(logFile, lines, { encoding: "utf-8", mode: 0o600 });
      await this.compact(logFile);
    } catch (e) {
      logger.warn("audit", "write-failed", String(e));
    }
  }

  private async compact(logFile: string): Promise<void> {
    const maxEntries = getMaxAuditEntries();
    try {
      const raw = await fs.readFile(logFile, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length <= maxEntries) return;
      // 轮换重写走同目录 exclusive staging + rename（0o600），避免中途可见的部分文件
      await atomicWriteFile(logFile, `${lines.slice(-maxEntries).join("\n")}\n`, "utf-8");
    } catch (e) {
      logger.warn("audit", "compact-failed", String(e));
    }
  }

  async recent(limit = 50): Promise<AuditEntry[]> {
    await this.flush();
    try {
      const logFile = await this.resolveLogFilePath();
      const raw = await fs.readFile(logFile, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const entries = lines
        .slice(-getMaxAuditEntries())
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch (err) {
            logger.debug("audit", "skip-malformed-line", String(err));
            return null;
          }
        })
        .filter((e): e is AuditEntry => e !== null);
      return entries.slice(-limit).reverse();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      logger.warn("audit", "read-failed", String(e));
      return [];
    }
  }

  /** 返回审计状态摘要（供 health / telemetry 使用） */
  summary(): { mode: AuditMode; enabled: boolean } {
    const mode = getAuditMode();
    return {
      mode,
      enabled: mode !== "off",
    };
  }

  async getLogFilePath(): Promise<string | null> {
    try {
      return await this.resolveLogFilePath();
    } catch (err) {
      logger.debug("audit", "log-file-path-unavailable", String(err));
      return null;
    }
  }
}

export const audit = new AuditLog();
