import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ES_EXE_ENV,
  ES_EXE_PATH,
  ES_EXE_SHA256,
  ensureEsExeIntegrity,
  resetEsIntegrityCache,
  resolveEsExe,
} from "../../src/es-integrity.js";
import { resetStateDirCache } from "../../src/state-dir.js";

describe("es-integrity", () => {
  let originalStateDir: string | undefined;
  let originalEsPath: string | undefined;
  let tempStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalEsPath = process.env[ES_EXE_ENV];
    tempStateDir = await fs.mkdtemp(path.join("E:/Codex_Temp", "mcp-es-integrity-test-"));
    process.env.MCP_STATE_DIR = tempStateDir;
    delete process.env[ES_EXE_ENV];
    resetStateDirCache();
    resetEsIntegrityCache();
  });

  afterEach(async () => {
    if (originalStateDir === undefined) delete process.env.MCP_STATE_DIR;
    else process.env.MCP_STATE_DIR = originalStateDir;
    if (originalEsPath === undefined) delete process.env[ES_EXE_ENV];
    else process.env[ES_EXE_ENV] = originalEsPath;
    resetStateDirCache();
    resetEsIntegrityCache();
    await fs.rm(tempStateDir, { recursive: true, force: true });
  });

  async function installStateFixture(): Promise<string> {
    const target = path.join(tempStateDir, "tools", "es.exe");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(ES_EXE_PATH, target);
    return target;
  }

  test("locked hash is 64 hex chars", () => {
    expect(ES_EXE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("fixture path remains available for explicit development tests", () => {
    expect(ES_EXE_PATH.replace(/\\/g, "/")).toMatch(/es_tool\/es\.exe$/);
  });

  test("accepts a valid explicit path and preserves the compatibility wrapper", async () => {
    process.env[ES_EXE_ENV] = ES_EXE_PATH;
    const result = await resolveEsExe();
    expect(result).toEqual({ available: true, source: "explicit", path: ES_EXE_PATH });
    expect(await ensureEsExeIntegrity()).toBe(ES_EXE_PATH);
  });

  test("uses the state path when no explicit path is configured", async () => {
    const statePath = await installStateFixture();
    const result = await resolveEsExe();
    expect(result).toEqual({ available: true, source: "state", path: statePath });
    expect(result.available && result.path).not.toBe(ES_EXE_PATH);
  });

  test("explicit missing path fails closed without trying the state fallback", async () => {
    await installStateFixture();
    const explicitPath = path.join(tempStateDir, "missing", "es.exe");
    process.env[ES_EXE_ENV] = explicitPath;
    const result = await resolveEsExe();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.source).toBe("explicit");
      expect(result.diagnostic.reason).toBe("explicit_path_missing");
      expect(result.diagnostic.download_performed).toBe(false);
    }
  });

  test("reports an unavailable implicit state binary without reading the fixture", async () => {
    const result = await resolveEsExe();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.source).toBe("state");
      expect(result.diagnostic.reason).toBe("state_path_missing");
      expect(result.diagnostic.path).toBe(path.join(tempStateDir, "tools", "es.exe"));
      expect(result.diagnostic.default_path).toBe(path.join(tempStateDir, "tools", "es.exe"));
      expect(result.diagnostic.expected_sha256).toBe(ES_EXE_SHA256);
      expect(result.diagnostic.env_name).toBe(ES_EXE_ENV);
      expect(result.diagnostic.download_performed).toBe(false);
    }
    await expect(fs.access(path.join(tempStateDir, "tools"))).rejects.toThrow();
  });

  test("rejects a state candidate that is not a regular file", async () => {
    await fs.mkdir(path.join(tempStateDir, "tools", "es.exe"), { recursive: true });
    const result = await resolveEsExe();
    expect(result).toMatchObject({
      available: false,
      source: "state",
      diagnostic: { reason: "state_path_not_file", download_performed: false },
    });
  });

  test("rejects an explicit candidate with a mismatched hash", async () => {
    const explicitPath = path.join(tempStateDir, "bad-es.exe");
    await fs.writeFile(explicitPath, "not the locked binary", "utf-8");
    process.env[ES_EXE_ENV] = explicitPath;
    const result = await resolveEsExe();
    expect(result).toMatchObject({
      available: false,
      source: "explicit",
      diagnostic: {
        reason: "explicit_hash_mismatch",
        path: explicitPath,
        download_performed: false,
      },
    });
    if (!result.available) expect(result.diagnostic.actual_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("rejects a state binary after its fingerprint changes to invalid content", async () => {
    const statePath = await installStateFixture();
    await expect(resolveEsExe()).resolves.toEqual({ available: true, source: "state", path: statePath });
    await fs.writeFile(statePath, "not an Everything binary", "utf-8");
    const result = await resolveEsExe();
    expect(result.available).toBe(false);
    if (!result.available) expect(result.diagnostic.reason).toBe("state_hash_mismatch");
  });

  test("shares concurrent first resolution", async () => {
    const statePath = await installStateFixture();
    const results = await Promise.all([resolveEsExe(), resolveEsExe(), resolveEsExe()]);
    expect(results).toEqual(results.map(() => ({ available: true, source: "state", path: statePath })));
  });
});
