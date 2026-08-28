/**
 * Session 状态管理单元测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetStateDirCache } from "../../src/state-dir.js";

describe("session", () => {
  let tmpStateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-session-test-"));
    process.env.MCP_STATE_DIR = tmpStateDir;
    resetStateDirCache();
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) process.env.MCP_STATE_DIR = originalStateDir;
    else delete process.env.MCP_STATE_DIR;
    resetStateDirCache();
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  test("fresh state starts from process cwd", async () => {
    // 每次重新导入以获得新实例
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    expect(store.getCwd()).toBe(process.cwd());
    expect(store.get()).toEqual({
      cwd: process.cwd(),
      env: {},
      history: [],
      createdAt: expect.any(Number),
    });
  });

  test("set cwd marks dirty and persists after flush", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    const newCwd = path.join(tmpStateDir, "nested");
    store.setCwd(newCwd);
    expect(store.getCwd()).toBe(newCwd);
    await store.flush();
    await new Promise((r) => setTimeout(r, 50));
    const raw = await fs.readFile(path.join(tmpStateDir, "session.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.cwd).toBe(newCwd);
  });

  test("env roundtrip", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    store.setEnv("FOO", "bar");
    expect(store.getEnv("FOO")).toBe("bar");
  });

  test("history trimmed to 50 in memory and 20 persisted", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    for (let i = 0; i < 55; i++) {
      store.pushHistory(`cmd-${i}`);
    }
    expect(store.lastCommand()).toBe("cmd-54");
    const state = store.get();
    expect(state.history.length).toBe(50);
    expect(state.history[0]).toBe("cmd-5");

    await store.flush();
    await new Promise((r) => setTimeout(r, 50));
    const raw = await fs.readFile(path.join(tmpStateDir, "session.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.history.length).toBe(20);
    expect(data.history[data.history.length - 1]).toBe("cmd-54");
  });

  test("reset clears state", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    store.setEnv("X", "y");
    store.pushHistory("cmd");
    store.reset();
    expect(store.getEnv("X")).toBeUndefined();
    expect(store.lastCommand()).toBeUndefined();
    expect(store.getCwd()).toBe(process.cwd());
  });

  test("snapshot reflects state", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    store.setEnv("A", "1");
    store.setEnv("B", "2");
    store.pushHistory("ls");
    const obj = store.snapshotObj();
    expect(obj.cwd).toBe(process.cwd());
    expect(obj.envKeys).toEqual(["A", "B"]);
    expect(obj.historyLength).toBe(1);
    expect(obj.uptimeMinutes).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(store.snapshot())).toEqual(obj);
  });

  test("restores cwd/history but drops env values by default (keys-only persistence)", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    store.setCwd(tmpStateDir);
    store.setEnv("KEY", "value");
    store.pushHistory("cmd1");
    await store.flush();

    const raw = await fs.readFile(path.join(tmpStateDir, "session.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.envKeys).toEqual(["KEY"]);
    expect(data.env).toBeUndefined(); // 默认不落 env value

    const { SessionStore: SessionStore2 } = await import("../../src/session.js");
    const store2 = new SessionStore2();
    await new Promise((r) => setTimeout(r, 50));
    expect(store2.getCwd()).toBe(tmpStateDir);
    expect(store2.getEnv("KEY")).toBeUndefined(); // value 不还原、不注入子进程
    expect(store2.lastCommand()).toBe("cmd1");
  });

  test("persists env values only under explicit opt-in and never for denied/sensitive keys", async () => {
    const original = process.env.MCP_SESSION_PERSIST_ENV_VALUES;
    process.env.MCP_SESSION_PERSIST_ENV_VALUES = "1";
    try {
      const { SessionStore } = await import("../../src/session.js");
      const store = new SessionStore();
      store.setEnv("MY_VAR", "ok-value");
      store.setEnv("MY_TOKEN", "secret-value"); // sensitive 关键词：可入内存，但永不落盘
      // denied key（大小写规范化）在 set 阶段即被拒绝，无法进入内存 env
      expect(() => store.setEnv("path", "C:\\evil")).toThrow(/denied/);
      await store.flush();

      const raw = await fs.readFile(path.join(tmpStateDir, "session.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.env).toEqual({ MY_VAR: "ok-value" });
      expect([...data.envKeys].sort()).toEqual(["MY_TOKEN", "MY_VAR"].sort());
    } finally {
      if (original === undefined) delete process.env.MCP_SESSION_PERSIST_ENV_VALUES;
      else process.env.MCP_SESSION_PERSIST_ENV_VALUES = original;
    }
  });

  test("persists history through the redactor", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    store.pushHistory('curl -H "Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" https://example.com');
    store.pushHistory("plain-cmd");
    await store.flush();

    const raw = await fs.readFile(path.join(tmpStateDir, "session.json"), "utf-8");
    const data = JSON.parse(raw);
    expect(data.history[data.history.length - 1]).toBe("plain-cmd");
    expect(data.history[0]).not.toContain("ghp_AAAA");
    expect(data.history[0]).toContain("[REDACTED]");
  });

  test("setEnv rejects denied keys case-insensitively (path/node_options variants)", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    expect(() => store.setEnv("path", "C:\\evil")).toThrow(/denied/);
    expect(() => store.setEnv("Node_Options", "--inspect")).toThrow(/denied/);
    expect(() => store.setEnv("ld_preload", "/lib/evil.so")).toThrow(/denied/);
    expect(store.getEnv("path")).toBeUndefined();
  });

  test("rejects restoring a cwd that resolves into a sensitive directory", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const sensitive = path.join(tmpStateDir, ".ssh");
    await fs.mkdir(sensitive);
    const link = path.join(tmpStateDir, "cwd-link");
    await fs.symlink(sensitive, link, "junction");

    const store = new SessionStore();
    store.setCwd(link);
    await store.flush();

    const { SessionStore: SessionStore2 } = await import("../../src/session.js");
    const store2 = new SessionStore2();
    await new Promise((r) => setTimeout(r, 50));
    expect(store2.getCwd()).not.toBe(link);
    expect(store2.getCwd()).toBe(process.cwd());
  });

  test("legacy global state file is not auto-imported (hint only)", async () => {
    // 4.5：%TEMP%\.enhanced-terminal-mcp-session.json 不自动导入或删除，只记录提示
    const legacyPath = path.join(os.tmpdir(), ".enhanced-terminal-mcp-session.json");
    const legacyData = {
      cwd: path.join(tmpStateDir, "legacy"),
      env: { LEGACY: "1" },
      history: ["legacy-cmd"],
      createdAt: Date.now(),
    };
    await fs.writeFile(legacyPath, JSON.stringify(legacyData));

    try {
      const { SessionStore } = await import("../../src/session.js");
      const store = new SessionStore();
      await store.loaded;
      // 状态保持全新，不从 legacy 文件恢复
      expect(store.getCwd()).toBe(process.cwd());
      expect(store.getEnv("LEGACY")).toBeUndefined();
      expect(store.lastCommand()).toBeUndefined();
      // legacy 文件保持原样，不被删除
      const raw = await fs.readFile(legacyPath, "utf-8");
      expect(JSON.parse(raw)).toEqual(legacyData);
    } finally {
      await fs.rm(legacyPath, { force: true });
    }
  });

  test("invalid persisted json triggers parse-failed and starts fresh", async () => {
    await fs.mkdir(tmpStateDir, { recursive: true });
    await fs.writeFile(path.join(tmpStateDir, "session.json"), "not-json");

    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    expect(store.getCwd()).toBe(process.cwd());
  });

  test("persist failure is logged but not thrown", async () => {
    const { SessionStore } = await import("../../src/session.js");
    const store = new SessionStore();
    store.setCwd(tmpStateDir);

    // 让 state-dir 返回不可写路径
    process.env.MCP_STATE_DIR = path.join(tmpStateDir, "__nonexistent__", "__bad__");
    resetStateDirCache();

    // 直接调用私有 saveToDisk，预期不会抛错
    await expect((store as any).saveToDisk()).resolves.toBeUndefined();
  });
});
