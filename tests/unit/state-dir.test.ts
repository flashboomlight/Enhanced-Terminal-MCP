/**
 * 状态目录管理单元测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetStateDirCache } from "../../src/state-dir.js";

describe("state-dir", () => {
  let originalStateDir: string | undefined;
  let tmpProjectDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    resetStateDirCache();
    tmpProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-state-dir-test-"));
  });

  afterEach(async () => {
    if (originalStateDir !== undefined) {
      process.env.MCP_STATE_DIR = originalStateDir;
    } else {
      delete process.env.MCP_STATE_DIR;
    }
    resetStateDirCache();
    await fs.rm(tmpProjectDir, { recursive: true, force: true });
  });

  test("getStateDir resolves without creating; ensureStateDir creates", async () => {
    delete process.env.MCP_STATE_DIR;
    resetStateDirCache();
    // 通过动态设置环境变量并重新加载模块来验证
    const customDir = path.join(tmpProjectDir, "custom-state");
    process.env.MCP_STATE_DIR = customDir;

    const { getStateDir, ensureStateDir } = await import("../../src/state-dir.js");
    const dir = await getStateDir();
    expect(dir).toBe(path.resolve(customDir));
    // 纯解析：不创建目录
    const beforeExists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(beforeExists).toBe(false);
    // 写路径专用 ensure 才创建
    const ensured = await ensureStateDir();
    expect(ensured).toBe(dir);
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  test("getStateFilePath returns session.json under state dir", async () => {
    process.env.MCP_STATE_DIR = tmpProjectDir;
    const { getStateFilePath, getStateDir } = await import("../../src/state-dir.js");
    const filePath = await getStateFilePath();
    const dir = await getStateDir();
    expect(filePath).toBe(path.join(dir, "session.json"));
  });

  test("getLegacyStateFilePath points to temp dir", async () => {
    const { getLegacyStateFilePath } = await import("../../src/state-dir.js");
    const legacy = getLegacyStateFilePath();
    expect(legacy).toContain(".enhanced-terminal-mcp-session.json");
    expect(path.dirname(legacy)).toBe(os.tmpdir());
  });

  test("getStateDirSync returns resolved path without creating", async () => {
    delete process.env.MCP_STATE_DIR;
    resetStateDirCache();
    const customDir = path.join(tmpProjectDir, "sync-state");
    process.env.MCP_STATE_DIR = customDir;
    resetStateDirCache();
    const { getStateDirSync } = await import("../../src/state-dir.js");
    const dir = getStateDirSync();
    expect(dir).toBe(path.resolve(customDir));
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  test("mkdir failure logs warning and throws", async () => {
    process.env.MCP_STATE_DIR = path.join("\\\\invalid\\path\\for\\state");
    resetStateDirCache();
    const { ensureStateDir } = await import("../../src/state-dir.js");
    await expect(ensureStateDir()).rejects.toThrow("Failed to create state directory");
  });

  test("default state dir is realpath(cwd)/.etmcp", async () => {
    delete process.env.MCP_STATE_DIR;
    resetStateDirCache();
    const { getStateDirSync } = await import("../../src/state-dir.js");
    const expected = path.join(await fs.realpath(process.cwd()), ".etmcp");
    expect(getStateDirSync()).toBe(expected);
  });

  test("relative MCP_STATE_DIR resolves against fixed projectRoot", async () => {
    process.env.MCP_STATE_DIR = "rel-state-dir";
    resetStateDirCache();
    const { getStateDirSync } = await import("../../src/state-dir.js");
    const expected = path.join(await fs.realpath(process.cwd()), "rel-state-dir");
    expect(getStateDirSync()).toBe(expected);
  });
});
