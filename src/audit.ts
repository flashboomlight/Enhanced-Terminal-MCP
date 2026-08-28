/**
 * 审计日志 — 结构化记录关键操作（production-hardening #8 / OPS-01 serialized writer）
 *
 * 写入语义：
 * - 单飞行写链（chainTail）串行全部落盘任务，append 顺序 = 入队顺序，flush/record/recent
 *   并发不交错；
 * - 写失败条目保留在内存队列按 5s 退避重试，绝不 splice 后静默丢失；连续失败 3 次
 *   health 转 failed；
 * - entry（MCP_AUDIT_MAX_ENTRY_BYTES，超限截断 detail/error 保留骨架）、queue
 *   （MCP_AUDIT_QUEUE_MAX_ENTRIES / _BYTES，超限丢最旧并计 dropped）、file
 *   （MCP_AUDIT_MAX_FILE_BYTES 触发轮换 audit.jsonl.N + 既有条数 compact）三层有界。
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

/** record() 返回契约（roadmap §5.7） */
export interface AuditRecordReport {
  accepted: boolean;
  queued: number;
  dropped: number;
}

/** flush() 返回契约（roadmap §5.0 FlushReport） */
export interface FlushReport {
  clean: boolean;
  queued: number;
  bytes: number;
  dropped: number;
  error?: string;
}

/** health() 返回契约（roadmap §5.7） */
export interface AuditHealth {
  state: "healthy" | "degraded" | "failed";
  queued: number;
  bytes: number;
  dropped: number;
  lastError?: string;
}

function getMaxAuditEntries(): number {
  return envInt("MCP_AUDIT_MAX_ENTRIES", 10000, 100);
}

function getAuditMode(): AuditMode {
  const env = (process.env.MCP_AUDIT_MODE || "errors").toLowerCase().trim();
  if (env === "off" || env === "errors" || env === "all") return env;
  logger.warn("audit", "bad-mode", `Unknown MCP_AUDIT_MODE="${env}", using "errors"`);
  return "errors";
}

function getQueueMaxEntries(): number {
  return envInt("MCP_AUDIT_QUEUE_MAX_ENTRIES", 2000, 1, 100000);
}

function getQueueMaxBytes(): number {
  return envInt("MCP_AUDIT_QUEUE_MAX_BYTES", 4 * 1024 * 1024, 1024);
}

function getMaxEntryBytes(): number {
  return envInt("MCP_AUDIT_MAX_ENTRY_BYTES", 64 * 1024, 1024);
}

function getMaxFileBytes(): number {
  return envInt("MCP_AUDIT_MAX_FILE_BYTES", 8 * 1024 * 1024, 64 * 1024);
}

function getMaxRotations(): number {
  return envInt("MCP_AUDIT_MAX_ROTATIONS", 1, 0, 10);
}

/** 写失败退避间隔与 failed 阈值（代码常量，不加配置面） */
const WRITE_RETRY_DELAY_MS = 5000;
const FAILED_THRESHOLD = 3;

/** 队列元素：entry 与其序列化字节数（避免丢弃时重复 stringify） */
interface QueuedEntry {
  entry: AuditEntry;
  bytes: number;
}

export class AuditLog {
  private queue: QueuedEntry[] = [];
  private queueBytes = 0;
  private dropped = 0;
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  /** 最近已知日志文件大小；-1 = 本进程尚未观测（下次写前 stat） */
  private lastFileSize = -1;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 单飞行写链：全部落盘任务经此串行 */
  private chainTail: Promise<void> = Promise.resolve();
  private writeScheduled = false;
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

  record(entry: Omit<AuditEntry, "timestamp">): AuditRecordReport {
    if (!this.shouldRecord(entry.success)) {
      return { accepted: false, queued: this.queue.length, dropped: this.dropped };
    }
    // 入队前完成净化：secret 原文/原始命令不以未脱敏形态进入内存队列或落盘
    const sanitized: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      detail: redactDetail(entry.detail) as Record<string, unknown>,
      error: entry.error !== undefined ? sanitizeLogField(entry.error) : undefined,
    };
    // 单条字节上限：超限截断 detail/error 保留骨架，操作仍可观测（不整条丢弃）
    const maxEntryBytes = getMaxEntryBytes();
    let lineBytes = 0;
    try {
      lineBytes = Buffer.byteLength(JSON.stringify(sanitized), "utf-8");
    } catch {
      lineBytes = maxEntryBytes + 1; // 序列化失败按超限处理
    }
    let final = sanitized;
    if (lineBytes > maxEntryBytes) {
      final = {
        ...sanitized,
        detail: { truncated: true, originalBytes: lineBytes },
        error: sanitized.error !== undefined ? sanitizeLogField(sanitized.error, 256) : undefined,
      };
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(final), "utf-8");
    } catch {
      bytes = 1024;
    }
    this.queue.push({ entry: final, bytes });
    this.queueBytes += bytes;
    // 队列上限：丢最旧并计数（保留至少当前 1 条，绝不阻塞调用方）
    while (
      this.queue.length > 1 &&
      (this.queue.length > getQueueMaxEntries() || this.queueBytes > getQueueMaxBytes())
    ) {
      const oldest = this.queue.shift();
      if (oldest) this.queueBytes -= oldest.bytes;
      this.dropped++;
    }
    if (this.dropped > 0 && this.dropped % 100 === 1) {
      logger.warn("audit", "queue-overflow-dropped", `total dropped=${this.dropped}`);
    }
    this.scheduleFlush();
    return { accepted: true, queued: this.queue.length, dropped: this.dropped };
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.retryTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.scheduleWrite();
    }, 1000);
  }

  /** 把一次"尽力写"任务排到写链尾部（去重）；drainOnce 内部自捕获，链不会断裂 */
  private scheduleWrite(): void {
    if (this.writeScheduled) return;
    this.writeScheduled = true;
    const task = this.chainTail.then(() => {
      this.writeScheduled = false;
      return this.drainOnce();
    });
    this.chainTail = task.catch(() => {});
  }

  /**
   * 单次写任务：整批 append（成功才清队列）；失败保留全部条目并按退避重排。
   * 轮换/compact 的失败只降级告警，不影响"已写入"事实。
   */
  private async drainOnce(): Promise<void> {
    if (this.queue.length === 0) return;
    let logFile: string;
    try {
      logFile = await this.ensureLogFilePath();
    } catch (e) {
      this.recordWriteFailure(e);
      return;
    }
    const lines = this.queue.map((q) => JSON.stringify(q.entry));
    const payload = `${lines.join("\n")}\n`;
    try {
      if (this.lastFileSize < 0) {
        // 本进程首次写：校准既有文件大小，保证轮换阈值判断正确
        try {
          const st = await fs.stat(logFile);
          this.lastFileSize = st.size;
        } catch {
          this.lastFileSize = 0;
        }
      }
      await fs.appendFile(logFile, payload, { encoding: "utf-8", mode: 0o600 });
    } catch (e) {
      this.recordWriteFailure(e);
      return;
    }
    // 写入成功：清队列、复位失败计数
    this.queue.length = 0;
    this.queueBytes = 0;
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.lastFileSize += Buffer.byteLength(payload, "utf-8");
    try {
      await this.rotateIfNeeded(logFile);
    } catch (e) {
      logger.warn("audit", "rotate-failed", String(e));
    }
    await this.compact(logFile);
  }

  private recordWriteFailure(e: unknown): void {
    this.consecutiveFailures++;
    this.lastError = String(e);
    logger.warn("audit", "write-failed", `attempt ${this.consecutiveFailures}: ${String(e)}`);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.queue.length > 0) this.scheduleWrite();
    }, WRITE_RETRY_DELAY_MS);
    this.retryTimer.unref?.();
  }

  /** 文件超 MCP_AUDIT_MAX_FILE_BYTES 时轮换：删最旧代、逐代前移、当前改 .1 */
  private async rotateIfNeeded(logFile: string): Promise<void> {
    if (this.lastFileSize <= getMaxFileBytes()) return;
    const maxRotations = getMaxRotations();
    if (maxRotations === 0) {
      await fs.rm(logFile, { force: true });
    } else {
      await fs.rm(`${logFile}.${maxRotations}`, { force: true }).catch(() => {});
      for (let i = maxRotations - 1; i >= 1; i--) {
        await fs.rename(`${logFile}.${i}`, `${logFile}.${i + 1}`).catch(() => {});
      }
      try {
        await fs.rename(logFile, `${logFile}.1`);
      } catch {
        // Windows 目标被短暂打开等瞬态：先删再试一次
        await fs.rm(`${logFile}.1`, { force: true }).catch(() => {});
        await fs.rename(logFile, `${logFile}.1`).catch(() => {});
      }
    }
    this.lastFileSize = 0;
    logger.info("audit", "rotated", logFile);
  }

  /** 条数裁剪（既有契约）：超过 MCP_AUDIT_MAX_ENTRIES 保留最新 N 条；轮换后文件有界，读取内存受控 */
  private async compact(logFile: string): Promise<void> {
    const maxEntries = getMaxAuditEntries();
    try {
      const raw = await fs.readFile(logFile, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length <= maxEntries) return;
      // 轮换重写走同目录 exclusive staging + rename（0o600），避免中途可见的部分文件
      const kept = `${lines.slice(-maxEntries).join("\n")}\n`;
      await atomicWriteFile(logFile, kept, "utf-8");
      this.lastFileSize = Buffer.byteLength(kept, "utf-8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // 轮换后当前文件尚未重建
      logger.warn("audit", "compact-failed", String(e));
    }
  }

  async flush(deadlineMs?: number): Promise<FlushReport> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const startedAt = Date.now();
    const within = () => deadlineMs === undefined || Date.now() - startedAt < deadlineMs;
    // 退避定时器挂起时不再立即重试（避免对着失败磁盘整段 deadline 连打）
    while (this.queue.length > 0 && this.retryTimer === null && within()) {
      this.scheduleWrite();
      await this.chainTail;
    }
    const report: FlushReport = {
      clean: this.queue.length === 0,
      queued: this.queue.length,
      bytes: this.queueBytes,
      dropped: this.dropped,
    };
    if (this.lastError !== undefined) report.error = this.lastError;
    return report;
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

  /** 同步健康面（roadmap §5.7）：写失败连续 3 次 = failed；dropped>0 或有失败在退避 = degraded */
  health(): AuditHealth {
    let state: "healthy" | "degraded" | "failed" = "healthy";
    if (this.consecutiveFailures >= FAILED_THRESHOLD) state = "failed";
    else if (this.dropped > 0 || this.consecutiveFailures > 0) state = "degraded";
    const health: AuditHealth = {
      state,
      queued: this.queue.length,
      bytes: Math.max(0, this.lastFileSize),
      dropped: this.dropped,
    };
    if (this.lastError !== undefined) health.lastError = sanitizeLogField(this.lastError, 200);
    return health;
  }

  /** 返回审计状态摘要（供 health / telemetry 使用） */
  summary(): { mode: AuditMode; enabled: boolean; state: string; queued: number; dropped: number } {
    const mode = getAuditMode();
    const h = this.health();
    return {
      mode,
      enabled: mode !== "off",
      state: h.state,
      queued: h.queued,
      dropped: h.dropped,
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
