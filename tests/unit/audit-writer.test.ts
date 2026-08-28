/**
 * audit serialized writer 单元测试（production-hardening #8 / OPS-01）
 *
 * 覆盖：写失败条目保留 + 重试、health 状态迁移、queue/entry 字节上限、
 * 文件轮换、FlushReport / record 契约面。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuditLog } from "../../src/audit.js";
import { resetStateDirCache } from "../../src/state-dir.js";

describe("audit serialized writer", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tmpStateDir: string;

  beforeEach(async () => {
    for (const key of [
      "MCP_STATE_DIR",
      "MCP_AUDIT_MODE",
      "MCP_AUDIT_MAX_ENTRIES",
      "MCP_AUDIT_QUEUE_MAX_ENTRIES",
      "MCP_AUDIT_QUEUE_MAX_BYTES",
      "MCP_AUDIT_MAX_ENTRY_BYTES",
      "MCP_AUDIT_MAX_FILE_BYTES",
      "MCP_AUDIT_MAX_ROTATIONS",
    ]) {
      savedEnv[key] = process.env[key];
    }
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-audit-writer-"));
    process.env.MCP_STATE_DIR = tmpStateDir;
    process.env.MCP_AUDIT_MODE = "all";
    resetStateDirCache();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStateDirCache();
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  test("record returns the §5.7 contract shape and flush reports clean", async () => {
    const audit = new AuditLog();
    const report = audit.record({ action: "a", detail: {}, success: true });
    expect(report).toMatchObject({ accepted: true, queued: 1, dropped: 0 });
    const flush = await audit.flush(1000);
    expect(flush).toMatchObject({ clean: true, queued: 0, dropped: 0 });
    expect(audit.health()).toMatchObject({ state: "healthy", queued: 0 });
  });

  test("off mode record is not accepted", async () => {
    process.env.MCP_AUDIT_MODE = "off";
    const audit = new AuditLog();
    const report = audit.record({ action: "a", detail: {}, success: true });
    expect(report.accepted).toBe(false);
  });

  test("write failure retains entries and health degrades; retry succeeds without loss", async () => {
    // <state>/logs 是文件 → mkdir 失败 → 写失败 → 条目必须仍在队列
    await fs.mkdir(tmpStateDir, { recursive: true });
    await fs.writeFile(path.join(tmpStateDir, "logs"), "not-a-dir", "utf-8");
    const audit = new AuditLog();
    audit.record({ action: "kept-1", detail: {}, success: true });
    audit.record({ action: "kept-2", detail: {}, success: true });
    const flush = await audit.flush(1000);
    expect(flush.clean).toBe(false);
    expect(flush.queued).toBe(2);
    expect(audit.health().state).toBe("degraded");
    expect(audit.health().queued).toBe(2);

    // 修复条件后重试：条目按原顺序落盘，零丢失
    await fs.rm(path.join(tmpStateDir, "logs"), { force: true });
    const audit2 = audit;
    (audit2 as unknown as { retryTimer: ReturnType<typeof setTimeout> | null }).retryTimer = null;
    const flush2 = await audit2.flush(1000);
    expect(flush2.clean).toBe(true);
    const raw = await fs.readFile(path.join(tmpStateDir, "logs", "audit.jsonl"), "utf-8");
    const actions = raw
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { action: string }).action);
    expect(actions).toEqual(["kept-1", "kept-2"]);
    expect(audit2.health().state).toBe("healthy");
  });

  test("three consecutive write failures put health into failed", async () => {
    await fs.mkdir(tmpStateDir, { recursive: true });
    await fs.writeFile(path.join(tmpStateDir, "logs"), "not-a-dir", "utf-8");
    const audit = new AuditLog();
    audit.record({ action: "x", detail: {}, success: true });
    // 白盒：连续驱动三次失败写（跳过 5s 退避等待）
    const driver = audit as unknown as { drainOnce(): Promise<void>; retryTimer: ReturnType<typeof setTimeout> | null };
    for (let i = 0; i < 3; i++) {
      driver.retryTimer = null;
      await driver.drainOnce();
    }
    expect(audit.health().state).toBe("failed");
    expect(audit.health().lastError).toBeTruthy();
  });

  test("queue overflow drops the oldest entries and counts dropped", async () => {
    process.env.MCP_AUDIT_QUEUE_MAX_ENTRIES = "5";
    const audit = new AuditLog();
    for (let i = 0; i < 10; i++) {
      audit.record({ action: `e${i}`, detail: {}, success: true });
    }
    const health = audit.health();
    expect(health.queued).toBe(5);
    expect(health.dropped).toBe(5);
    await audit.flush(1000);
    const raw = await fs.readFile(path.join(tmpStateDir, "logs", "audit.jsonl"), "utf-8");
    const actions = raw
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { action: string }).action);
    // 丢最旧：保留 e5..e9
    expect(actions).toEqual(["e5", "e6", "e7", "e8", "e9"]);
  });

  test("oversized entries are truncated but still recorded", async () => {
    process.env.MCP_AUDIT_MAX_ENTRY_BYTES = "1024";
    const audit = new AuditLog();
    audit.record({ action: "big", detail: { blob: "x".repeat(5000) }, success: false, error: "e".repeat(3000) });
    await audit.flush(1000);
    const raw = await fs.readFile(path.join(tmpStateDir, "logs", "audit.jsonl"), "utf-8");
    expect(raw.length).toBeLessThan(2000);
    const entry = JSON.parse(raw.trim()) as { action: string; detail: Record<string, unknown> };
    expect(entry.action).toBe("big");
    expect(entry.detail).toMatchObject({ truncated: true });
  });

  test("file rotation by size keeps the configured generation with 0o600", async () => {
    if (process.platform === "win32") {
      // POSIX mode 断言仅 Unix 有意义；轮换行为本身在下方照常验证
    }
    process.env.MCP_AUDIT_MAX_FILE_BYTES = "65536";
    const audit = new AuditLog();
    for (let i = 0; i < 120; i++) {
      audit.record({ action: `row-${i}`, detail: { pad: "y".repeat(700) }, success: true });
    }
    await audit.flush(2000);
    const current = path.join(tmpStateDir, "logs", "audit.jsonl");
    const rotated = `${current}.1`;
    const rotatedRaw = await fs.readFile(rotated, "utf-8");
    expect(rotatedRaw.length).toBeGreaterThan(65536);
    // 轮换后当前文件被改名离开：重建前不存在，存在则必有界
    try {
      expect((await fs.stat(current)).size).toBeLessThanOrEqual(65536 + 2048);
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    if (process.platform !== "win32") {
      const mode = (await fs.stat(rotated)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  test("flush deadline stops retrying a failing sink and reports remaining bytes", async () => {
    await fs.mkdir(tmpStateDir, { recursive: true });
    await fs.writeFile(path.join(tmpStateDir, "logs"), "not-a-dir", "utf-8");
    const audit = new AuditLog();
    audit.record({ action: "pending", detail: { pad: "z".repeat(100) }, success: true });
    const flush = await audit.flush(50);
    expect(flush.clean).toBe(false);
    expect(flush.queued).toBe(1);
    expect(flush.bytes).toBeGreaterThan(0);
    expect(flush.error).toBeTruthy();
  });
});
