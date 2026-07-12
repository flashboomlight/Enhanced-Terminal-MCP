/**
 * 审计日志 — 结构化记录关键操作
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { getStateDir } from "./state-dir.js";
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
  private logFilePromise: Promise<string> | null = null;

  private async getLogFile(): Promise<string> {
    if (this.logFilePromise) return this.logFilePromise;
    this.logFilePromise = (async () => {
      const dir = await getStateDir();
      const logsDir = path.join(dir, "logs");
      await fs.mkdir(logsDir, { recursive: true });
      return path.join(logsDir, "audit.jsonl");
    })();
    return this.logFilePromise;
  }

  private shouldRecord(success: boolean): boolean {
    const mode = getAuditMode();
    if (mode === "off") return false;
    if (mode === "all") return true;
    return !success; // errors
  }

  record(entry: Omit<AuditEntry, "timestamp">): void {
    if (!this.shouldRecord(entry.success)) return;
    this.queue.push({ ...entry, timestamp: new Date().toISOString() });
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
      const logFile = await this.getLogFile();
      const lines = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
      await fs.appendFile(logFile, lines, "utf-8");
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
      await fs.writeFile(logFile, `${lines.slice(-maxEntries).join("\n")}\n`, "utf-8");
    } catch (e) {
      logger.warn("audit", "compact-failed", String(e));
    }
  }

  async recent(limit = 50): Promise<AuditEntry[]> {
    await this.flush();
    try {
      const logFile = await this.getLogFile();
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
      return await this.getLogFile();
    } catch (err) {
      logger.debug("audit", "log-file-path-unavailable", String(err));
      return null;
    }
  }
}

export const audit = new AuditLog();
