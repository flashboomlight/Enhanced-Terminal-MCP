/**
 * 审计日志测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type AuditEntry, AuditLog } from "../../src/audit.js";
import { resetStateDirCache } from "../../src/state-dir.js";

describe("audit", () => {
  let originalStateDir: string | undefined;
  let originalAuditMode: string | undefined;
  let originalAuditMaxEntries: string | undefined;
  let tmpStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalAuditMode = process.env.MCP_AUDIT_MODE;
    originalAuditMaxEntries = process.env.MCP_AUDIT_MAX_ENTRIES;
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-audit-test-"));
    process.env.MCP_STATE_DIR = tmpStateDir;
    process.env.MCP_AUDIT_MODE = "all";
    resetStateDirCache();
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) process.env.MCP_STATE_DIR = originalStateDir;
    else delete process.env.MCP_STATE_DIR;
    if (originalAuditMode !== undefined) process.env.MCP_AUDIT_MODE = originalAuditMode;
    else delete process.env.MCP_AUDIT_MODE;
    if (originalAuditMaxEntries !== undefined) process.env.MCP_AUDIT_MAX_ENTRIES = originalAuditMaxEntries;
    else delete process.env.MCP_AUDIT_MAX_ENTRIES;
    resetStateDirCache();
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  function makeAudit(): AuditLog {
    return new AuditLog();
  }

  test("record writes entries to audit.jsonl", async () => {
    const audit = makeAudit();
    audit.record({ action: "test.action", detail: { x: 1 }, success: true });
    await audit.flush();

    const logFile = path.join(tmpStateDir, "logs", "audit.jsonl");
    const raw = await fs.readFile(logFile, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]) as AuditEntry;
    expect(entry.action).toBe("test.action");
    expect(entry.success).toBe(true);
    expect(entry.detail.x).toBe(1);
  });

  test("recent returns entries in reverse chronological order", async () => {
    const audit = makeAudit();
    audit.record({ action: "first", detail: {}, success: true });
    audit.record({ action: "second", detail: {}, success: false });
    await audit.flush();

    const entries = await audit.recent(10);
    expect(entries.length).toBe(2);
    expect(entries[0].action).toBe("second");
    expect(entries[1].action).toBe("first");
  });

  test("off mode skips recording", async () => {
    process.env.MCP_AUDIT_MODE = "off";
    const audit = makeAudit();
    audit.record({ action: "skipped", detail: {}, success: true });
    await audit.flush();

    const logFile = path.join(tmpStateDir, "logs", "audit.jsonl");
    let exists = false;
    try {
      await fs.access(logFile);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      const raw = await fs.readFile(logFile, "utf-8");
      expect(raw.trim()).toBe("");
    } else {
      expect(exists).toBe(false);
    }
  });

  test("flush compacts audit log to max retained entries", async () => {
    process.env.MCP_AUDIT_MAX_ENTRIES = "100";
    const audit = makeAudit();
    for (let i = 0; i < 105; i++) {
      audit.record({ action: `entry-${i}`, detail: {}, success: true });
    }
    await audit.flush();

    const logFile = path.join(tmpStateDir, "logs", "audit.jsonl");
    const raw = await fs.readFile(logFile, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(100);
    expect((JSON.parse(lines[0]) as AuditEntry).action).toBe("entry-5");
  });
});
