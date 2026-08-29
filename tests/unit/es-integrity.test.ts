import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ES_EXE_ENV, ensureEsExeIntegrity, resetEsIntegrityCache, resolveEsExe } from "../../src/es-integrity.js";
import { resetStateDirCache } from "../../src/state-dir.js";

const TMP_DIR = fileURLToPath(new URL("../../.etmcp/test-tmp/", import.meta.url));

describe("es-integrity", () => {
  let originalStateDir: string | undefined;
  let originalEsPath: string | undefined;
  let tempStateDir: string;

  beforeEach(async () => {
    originalStateDir = process.env.MCP_STATE_DIR;
    originalEsPath = process.env[ES_EXE_ENV];
    await fs.mkdir(TMP_DIR, { recursive: true });
    tempStateDir = await fs.mkdtemp(path.join(TMP_DIR, "mcp-es-integrity-test-"));
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
    await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function installStateBinary(contents: string = "fake es.exe"): Promise<string> {
    const target = path.join(tempStateDir, "tools", "es.exe");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents, "utf-8");
    return target;
  }

  test("accepts a valid explicit path and preserves the compatibility wrapper", async () => {
    const explicitPath = path.join(tempStateDir, "my-es.exe");
    await fs.writeFile(explicitPath, "fake es.exe", "utf-8");
    process.env[ES_EXE_ENV] = explicitPath;
    const result = await resolveEsExe();
    expect(result).toEqual({ available: true, source: "explicit", path: explicitPath });
    expect(await ensureEsExeIntegrity()).toBe(explicitPath);
  });

  test("resolves a relative explicit path against the process cwd", async () => {
    const explicitPath = path.join(tempStateDir, "rel-es.exe");
    await fs.writeFile(explicitPath, "fake es.exe", "utf-8");
    const relative = path.relative(process.cwd(), explicitPath);
    process.env[ES_EXE_ENV] = relative;
    const result = await resolveEsExe();
    expect(result).toEqual({ available: true, source: "explicit", path: path.resolve(relative) });
  });

  test("accepts arbitrary user-provided content without a version lock", async () => {
    // 2026-08-30 everything-distribution-compliance：不再做固定 SHA-256 锁定，
    // 用户自带二进制版本不受本项目控制，只校验存在性与普通文件类型
    const explicitPath = path.join(tempStateDir, "upgraded-es.exe");
    await fs.writeFile(explicitPath, "not any specific official build", "utf-8");
    process.env[ES_EXE_ENV] = explicitPath;
    const result = await resolveEsExe();
    expect(result).toEqual({ available: true, source: "explicit", path: explicitPath });
  });

  test("uses the state path when no explicit path is configured", async () => {
    const statePath = await installStateBinary();
    const result = await resolveEsExe();
    expect(result).toEqual({ available: true, source: "state", path: statePath });
  });

  test("explicit missing path fails closed without trying the state fallback", async () => {
    await installStateBinary();
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

  test("reports an unavailable implicit state binary without creating the tools dir", async () => {
    const result = await resolveEsExe();
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.source).toBe("state");
      expect(result.diagnostic.reason).toBe("state_path_missing");
      expect(result.diagnostic.path).toBe(path.join(tempStateDir, "tools", "es.exe"));
      expect(result.diagnostic.default_path).toBe(path.join(tempStateDir, "tools", "es.exe"));
      expect(result.diagnostic.env_name).toBe(ES_EXE_ENV);
      expect(result.diagnostic.download_performed).toBe(false);
      // 哈希字段随固定 SHA-256 一并下线
      expect(result.diagnostic).not.toHaveProperty("expected_sha256");
      expect(result.diagnostic).not.toHaveProperty("actual_sha256");
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

  test("rejects an explicit candidate that is not a regular file", async () => {
    const explicitDir = path.join(tempStateDir, "es-dir.exe");
    await fs.mkdir(explicitDir, { recursive: true });
    process.env[ES_EXE_ENV] = explicitDir;
    const result = await resolveEsExe();
    expect(result).toMatchObject({
      available: false,
      source: "explicit",
      diagnostic: { reason: "explicit_path_not_file", download_performed: false },
    });
  });

  test("caches a successful resolution for the process lifetime", async () => {
    const statePath = await installStateBinary();
    await expect(resolveEsExe()).resolves.toEqual({ available: true, source: "state", path: statePath });
    // 成功后进程级缓存：文件被删除仍命中缓存；reset 后重验才暴露缺失
    await fs.rm(statePath);
    await expect(resolveEsExe()).resolves.toEqual({ available: true, source: "state", path: statePath });
    resetEsIntegrityCache();
    const result = await resolveEsExe();
    expect(result.available).toBe(false);
    if (!result.available) expect(result.diagnostic.reason).toBe("state_path_missing");
  });

  test("does not cache failures and picks up a later install", async () => {
    const first = await resolveEsExe();
    expect(first.available).toBe(false);
    const statePath = await installStateBinary();
    // 失败不缓存：用户装上 es.exe 后无需重启即可被解析到
    await expect(resolveEsExe()).resolves.toEqual({ available: true, source: "state", path: statePath });
  });

  test("shares concurrent first resolution", async () => {
    const statePath = await installStateBinary();
    const results = await Promise.all([resolveEsExe(), resolveEsExe(), resolveEsExe()]);
    expect(results).toEqual(results.map(() => ({ available: true, source: "state", path: statePath })));
  });

  test("ensureEsExeIntegrity returns null when unavailable", async () => {
    await expect(ensureEsExeIntegrity()).resolves.toBeNull();
  });
});
