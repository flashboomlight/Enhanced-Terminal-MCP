/**
 * 状态目录迁移（4.5 协议）单元测试
 * 通过 runStateMigration 注入临时 projectRoot/stateDir 驱动，不触碰真实仓库目录
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureStateMigration, resetStateDirCache, runStateMigration } from "../../src/state-dir.js";

const LEGACY_DIR_NAME = ".enhanced-terminal-mcp";

describe("state-migration", () => {
  let root: string;
  let legacyRoot: string;
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-migration-test-"));
    legacyRoot = path.join(root, LEGACY_DIR_NAME);
    stateDir = path.join(root, ".etmcp");
    resetStateDirCache();
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) {
      process.env.MCP_STATE_DIR = originalStateDir;
    } else {
      delete process.env.MCP_STATE_DIR;
    }
    resetStateDirCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function exists(p: string): Promise<boolean> {
    return fs
      .access(p)
      .then(() => true)
      .catch(() => false);
  }

  async function writeLegacySession(data: unknown): Promise<void> {
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "session.json"), JSON.stringify(data), "utf-8");
  }

  async function writeLegacyAudit(lines: string[]): Promise<void> {
    await fs.mkdir(path.join(legacyRoot, "logs"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "logs", "audit.jsonl"), `${lines.join("\n")}\n`, "utf-8");
  }

  test("no legacy dir is a no-op and does not create state dir", async () => {
    await runStateMigration(root, stateDir);
    expect(await exists(stateDir)).toBe(false);
  });

  test("migrates session.json when target missing, verifies and deletes source", async () => {
    const data = { cwd: root, env: { A: "1" }, history: ["cmd1"], createdAt: Date.now() };
    await writeLegacySession(data);

    await runStateMigration(root, stateDir);

    const migrated = JSON.parse(await fs.readFile(path.join(stateDir, "session.json"), "utf-8"));
    expect(migrated).toEqual(data);
    expect(await exists(path.join(legacyRoot, "session.json"))).toBe(false);
    // 旧根已完全为空，应被移除
    expect(await exists(legacyRoot)).toBe(false);
  });

  test("valid existing target wins: skipped_target_exists, source kept", async () => {
    const legacyData = { cwd: path.join(root, "old"), env: {}, history: [], createdAt: 1 };
    const targetData = { cwd: path.join(root, "new"), env: {}, history: ["newer"], createdAt: 2 };
    await writeLegacySession(legacyData);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "session.json"), JSON.stringify(targetData), "utf-8");

    await runStateMigration(root, stateDir);

    // 目标为权威，不覆盖
    const current = JSON.parse(await fs.readFile(path.join(stateDir, "session.json"), "utf-8"));
    expect(current).toEqual(targetData);
    // 源保留
    const legacy = JSON.parse(await fs.readFile(path.join(legacyRoot, "session.json"), "utf-8"));
    expect(legacy).toEqual(legacyData);
    // 旧根非空（源保留），不得移除
    expect(await exists(legacyRoot)).toBe(true);
  });

  test("corrupt source session.json aborts with STATE_MIGRATION_FAILED, nothing changed", async () => {
    await fs.mkdir(legacyRoot, { recursive: true });
    const src = path.join(legacyRoot, "session.json");
    await fs.writeFile(src, "not-json{", "utf-8");

    await expect(runStateMigration(root, stateDir)).rejects.toThrow("STATE_MIGRATION_FAILED");

    // 源保持原样、目标未创建、锁已释放
    expect(await fs.readFile(src, "utf-8")).toBe("not-json{");
    expect(await exists(path.join(stateDir, "session.json"))).toBe(false);
    expect(await exists(path.join(stateDir, ".migration.lock"))).toBe(false);
  });

  test("corrupt existing target session.json aborts startup", async () => {
    await writeLegacySession({ cwd: root, env: {}, history: [], createdAt: 1 });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "session.json"), "{broken", "utf-8");

    await expect(runStateMigration(root, stateDir)).rejects.toThrow("STATE_MIGRATION_FAILED");

    // 源与目标均保持不变
    expect(await fs.readFile(path.join(stateDir, "session.json"), "utf-8")).toBe("{broken");
    expect(await exists(path.join(legacyRoot, "session.json"))).toBe(true);
  });

  test("non-UTF8 source aborts with STATE_MIGRATION_FAILED", async () => {
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "session.json"), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));

    await expect(runStateMigration(root, stateDir)).rejects.toThrow("STATE_MIGRATION_FAILED");
    expect(await exists(path.join(stateDir, "session.json"))).toBe(false);
  });

  test("migrates audit.jsonl when target missing, byte-identical and source deleted", async () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", action: "a", detail: {}, success: true }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", action: "b", detail: { x: 1 }, success: false }),
    ];
    await writeLegacyAudit(lines);

    await runStateMigration(root, stateDir);

    const dst = path.join(stateDir, "logs", "audit.jsonl");
    expect(await fs.readFile(dst, "utf-8")).toBe(`${lines.join("\n")}\n`);
    expect(await exists(path.join(legacyRoot, "logs", "audit.jsonl"))).toBe(false);
    // 旧 logs 空目录与旧根均被移除
    expect(await exists(path.join(legacyRoot, "logs"))).toBe(false);
    expect(await exists(legacyRoot)).toBe(false);
  });

  test("merges audit.jsonl old-before-new with exact dedup, deletes old after verify", async () => {
    const a = JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", action: "a", detail: {}, success: true });
    const b = JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", action: "b", detail: {}, success: true });
    const c = JSON.stringify({ timestamp: "2026-01-01T00:00:02Z", action: "c", detail: {}, success: false });
    await writeLegacyAudit([a, b]);
    await fs.mkdir(path.join(stateDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "logs", "audit.jsonl"), `${b}\n${c}\n`, "utf-8");

    await runStateMigration(root, stateDir);

    const merged = (await fs.readFile(path.join(stateDir, "logs", "audit.jsonl"), "utf-8")).split("\n").filter(Boolean);
    expect(merged).toEqual([a, b, c]);
    for (const line of merged) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(await exists(path.join(legacyRoot, "logs", "audit.jsonl"))).toBe(false);
  });

  test("unparseable audit line aborts without overwriting either file", async () => {
    const good = JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", action: "a", detail: {}, success: true });
    await writeLegacyAudit([good, "garbage-line"]);
    await fs.mkdir(path.join(stateDir, "logs"), { recursive: true });
    const dst = path.join(stateDir, "logs", "audit.jsonl");
    await fs.writeFile(dst, `${good}\n`, "utf-8");

    await expect(runStateMigration(root, stateDir)).rejects.toThrow("STATE_MIGRATION_FAILED");

    // 两个原文件都不被覆盖/删除，staging 被清理
    expect(await fs.readFile(dst, "utf-8")).toBe(`${good}\n`);
    const srcLines = (await fs.readFile(path.join(legacyRoot, "logs", "audit.jsonl"), "utf-8"))
      .split("\n")
      .filter(Boolean);
    expect(srcLines).toEqual([good, "garbage-line"]);
    const leftovers = await fs.readdir(path.join(stateDir, "logs"));
    expect(leftovers.filter((f) => f.includes(".migrate-"))).toEqual([]);
  });

  test("unknown files and temp are never deleted; non-empty legacy root kept", async () => {
    await writeLegacySession({ cwd: root, env: {}, history: [], createdAt: 1 });
    await fs.writeFile(path.join(legacyRoot, "unknown.txt"), "keep me", "utf-8");
    await fs.mkdir(path.join(legacyRoot, "temp"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "temp", "junk.bin"), "junk", "utf-8");

    await runStateMigration(root, stateDir);

    expect(await exists(path.join(stateDir, "session.json"))).toBe(true);
    expect(await fs.readFile(path.join(legacyRoot, "unknown.txt"), "utf-8")).toBe("keep me");
    expect(await fs.readFile(path.join(legacyRoot, "temp", "junk.bin"), "utf-8")).toBe("junk");
    expect(await exists(legacyRoot)).toBe(true);
  });

  test("legacy root as junction is skipped entirely", async (ctx) => {
    const realLegacy = path.join(root, "real-legacy");
    await fs.mkdir(realLegacy, { recursive: true });
    await fs.writeFile(path.join(realLegacy, "session.json"), JSON.stringify({ cwd: root }), "utf-8");
    try {
      await fs.symlink(realLegacy, legacyRoot, "junction");
    } catch {
      ctx.skip();
      return;
    }

    await runStateMigration(root, stateDir);

    // 不跟随 junction：不迁移、不创建状态目录、目标目录内容保持
    expect(await exists(path.join(stateDir, "session.json"))).toBe(false);
    expect(await exists(path.join(realLegacy, "session.json"))).toBe(true);
  });

  test("symlinked session.json source is skipped without migration", async (ctx) => {
    const realFile = path.join(root, "real-session.json");
    await fs.writeFile(realFile, JSON.stringify({ cwd: root }), "utf-8");
    await fs.mkdir(legacyRoot, { recursive: true });
    try {
      await fs.symlink(realFile, path.join(legacyRoot, "session.json"), "file");
    } catch {
      ctx.skip();
      return;
    }

    await runStateMigration(root, stateDir);

    expect(await exists(path.join(stateDir, "session.json"))).toBe(false);
    // 源 symlink 保持，不被删除
    expect(await exists(path.join(legacyRoot, "session.json"))).toBe(true);
  });

  test("held migration lock times out with STATE_MIGRATION_FAILED", { timeout: 20000 }, async () => {
    await writeLegacySession({ cwd: root, env: {}, history: [], createdAt: 1 });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, ".migration.lock"), "held", "utf-8");

    await expect(runStateMigration(root, stateDir)).rejects.toThrow("STATE_MIGRATION_FAILED");

    // 超时不抢占锁：锁文件原样保留，源未迁移
    expect(await fs.readFile(path.join(stateDir, ".migration.lock"), "utf-8")).toBe("held");
    expect(await exists(path.join(legacyRoot, "session.json"))).toBe(true);
  });

  test("ensureStateMigration is skipped when MCP_STATE_DIR is set", async () => {
    process.env.MCP_STATE_DIR = path.join(root, "explicit-state");
    resetStateDirCache();
    // 即便默认源位置存在旧目录，显式覆盖时也不迁移（此处通过不创建旧目录验证无副作用）
    await ensureStateMigration();
    expect(await exists(path.join(root, "explicit-state"))).toBe(false);
  });

  test("ensureStateMigration is memoized", async () => {
    process.env.MCP_STATE_DIR = path.join(root, "explicit-state");
    resetStateDirCache();
    const p1 = ensureStateMigration();
    const p2 = ensureStateMigration();
    expect(p1).toBe(p2);
    await p1;
  });
});
