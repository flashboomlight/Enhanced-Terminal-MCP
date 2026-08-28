/**
 * SecretGovernance 单元测试 — redactor / env policy / scan 完备性（SEC-04/SEC-05）
 *
 * redactor 覆盖 roadmap §5.5 验收目标：GitHub token / OpenAI / JWT /
 * connection string / private key / URL credentials 不以原文出现在出口；
 * env policy 覆盖大小写规范化 deny（path/node_options 变体）与值展示/持久化策略。
 */
import { afterEach, describe, expect, test } from "vitest";
import { toolCache } from "../../src/cache.js";
import { Errors, success } from "../../src/result.js";
import { scanContent } from "../../src/scan.js";
import {
  envValueDisplayAllowed,
  getEnvValueMode,
  isDeniedEnvKey,
  persistentEnvValueAllowed,
  REDACTED,
  redactCommand,
  redactDetail,
  redactError,
  redactText,
  sanitizeLogField,
  validateEnvKeyPolicy,
} from "../../src/secret-governance.js";
import { wrapHandler } from "../../src/wrap.js";

const ENV_KEYS = [
  "MCP_SECRETS_SCAN",
  "MCP_ENV_VALUE_MODE",
  "MCP_ENV_VALUE_ALLOWLIST",
  "MCP_SESSION_PERSIST_ENV_VALUES",
] as const;

describe("secret-governance redactor", () => {
  test("redactText masks registered secret patterns", () => {
    expect(redactText("token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 done")).not.toContain("ghp_ABCD");
    expect(redactText("key sk-abcdefghijklmnopqrstuvwxyzaa123456 end")).toContain(REDACTED);
    expect(
      redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c"),
    ).toContain(REDACTED);
    expect(redactText("db mysql://admin:s3cret@db.example.com/prod")).not.toContain("s3cret");
    expect(redactText("-----BEGIN RSA PRIVATE KEY-----")).toContain(REDACTED);
  });

  test("redactText masks URL userinfo credentials while keeping scheme and user", () => {
    const out = redactText("curl https://alice:hunter2@example.com/api");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("https://alice:");
    expect(out).toContain(`${REDACTED}@example.com`);
  });

  test("redactText leaves plain text untouched and is stable across calls", () => {
    const plain = "echo hello world --flag=value";
    expect(redactText(plain)).toBe(plain);
    expect(redactText(redactText("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12"))).toBe(
      redactText("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12"),
    );
  });

  test("redactCommand caps by code points with ellipsis", () => {
    const long = "a".repeat(3000);
    expect(redactCommand(long).length).toBeLessThanOrEqual(2001);
    expect(redactCommand(long).endsWith("…")).toBe(true);
    expect(redactCommand("echo ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12")).toBe(`echo ${REDACTED}`);
  });

  test("sanitizeLogField escapes control characters and redacts", () => {
    expect(sanitizeLogField("line1\r\nline2")).toBe("line1\\r\\nline2");
    expect(sanitizeLogField("tab\there")).toBe("tab\\there");
    expect(sanitizeLogField("esc\x1b[31m")).toBe("esc\\x1b[31m");
    expect(sanitizeLogField("tok ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12")).not.toContain("ghp_ABCD");
  });

  test("sanitizeLogField truncates by UTF-8 bytes", () => {
    const out = sanitizeLogField("x".repeat(5000), 1000);
    expect(Buffer.byteLength(out, "utf-8")).toBeLessThanOrEqual(1000);
    expect(out.endsWith("...")).toBe(true);
  });

  test("redactDetail redacts strings, caps long values and total size", () => {
    const detail = redactDetail({ command: "run ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12", n: 1, nested: { ok: true } });
    expect(JSON.stringify(detail)).not.toContain("ghp_ABCD");
    expect((detail as any).n).toBe(1);

    const big = redactDetail({ blob: "y".repeat(20000) }, { maxStringChars: 100 });
    expect((big as any).blob.length).toBeLessThanOrEqual(101);

    const overall = redactDetail({ a: "z".repeat(20000), b: "w".repeat(20000) }, { maxBytes: 100 });
    expect(overall).toEqual({ truncated: true });
  });

  test("redactError normalizes unknown errors into sanitized structured errors", () => {
    const err = redactError(new Error("boom ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12"));
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.retryable).toBe(false);
    expect(err.message).not.toContain("ghp_ABCD");
    expect(err.detail).toEqual({ name: "Error" });

    const fromString = redactError("plain failure");
    expect(fromString.message).toBe("plain failure");
  });
});

describe("secret-governance env policy", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test("deny set matches case-insensitively (path/node_options variants)", () => {
    expect(isDeniedEnvKey("PATH")).toBe(true);
    expect(isDeniedEnvKey("path")).toBe(true);
    expect(isDeniedEnvKey("Path")).toBe(true);
    expect(isDeniedEnvKey("NODE_OPTIONS")).toBe(true);
    expect(isDeniedEnvKey("node_options")).toBe(true);
    expect(isDeniedEnvKey("LD_PRELOAD")).toBe(true);
    expect(isDeniedEnvKey("MY_VAR")).toBe(false);
  });

  test("validateEnvKeyPolicy separates shape errors from deny errors", () => {
    expect(validateEnvKeyPolicy("")).toBe("invalid env key");
    expect(validateEnvKeyPolicy("A=B")).toBe("invalid env key");
    expect(validateEnvKeyPolicy("A".repeat(257))).toBe("invalid env key");
    expect(validateEnvKeyPolicy("path")).toMatch(/denied/);
    expect(validateEnvKeyPolicy("MY_OK_KEY")).toBeNull();
  });

  test("envValueDisplayAllowed: sensitive keys always masked, mode decides the rest", () => {
    process.env.MCP_ENV_VALUE_MODE = "full";
    expect(envValueDisplayAllowed("MY_API_KEY")).toBe(false);
    expect(envValueDisplayAllowed("ETMCP_ANY")).toBe(true);

    process.env.MCP_ENV_VALUE_MODE = "keys";
    expect(envValueDisplayAllowed("PATH")).toBe(false);
    expect(envValueDisplayAllowed("ETMCP_ANY")).toBe(false);

    delete process.env.MCP_ENV_VALUE_MODE; // 默认 allowlist
    expect(envValueDisplayAllowed("Path")).toBe(true);
    expect(envValueDisplayAllowed("ETMCP_ANY")).toBe(false);
    process.env.MCP_ENV_VALUE_ALLOWLIST = "etmcp_any";
    expect(envValueDisplayAllowed("ETMCP_ANY")).toBe(true);
  });

  test("getEnvValueMode falls back to allowlist with warning on invalid input", () => {
    delete process.env.MCP_ENV_VALUE_MODE;
    expect(getEnvValueMode()).toEqual({ mode: "allowlist" });
    process.env.MCP_ENV_VALUE_MODE = "FULL";
    expect(getEnvValueMode()).toEqual({ mode: "full" });
    process.env.MCP_ENV_VALUE_MODE = "everything";
    expect(getEnvValueMode()).toEqual({ mode: "allowlist", warning: expect.stringContaining("allowlist") });
  });

  test("persistentEnvValueAllowed requires explicit opt-in and excludes denied/sensitive keys", () => {
    delete process.env.MCP_SESSION_PERSIST_ENV_VALUES;
    expect(persistentEnvValueAllowed("MY_VAR")).toBe(false);
    process.env.MCP_SESSION_PERSIST_ENV_VALUES = "1";
    expect(persistentEnvValueAllowed("MY_VAR")).toBe(true);
    expect(persistentEnvValueAllowed("path")).toBe(false);
    expect(persistentEnvValueAllowed("MY_TOKEN")).toBe(false);
  });
});

describe("scan completeness semantics", () => {
  afterEach(() => {
    delete process.env.MCP_SECRETS_SCAN;
  });

  test("oversize content is scanned on the prefix and marked incomplete, not safe", () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    const big = `x`.repeat(5 * 1024 * 1024);
    const scan = scanContent(big);
    expect(scan.complete).toBe(false);
    expect(scan.scannedBytes).toBeGreaterThan(0);
    expect(scan.scannedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(scan.findings).toEqual([]);
  });

  test("secret inside the scanned prefix is still reported for oversize content", () => {
    process.env.MCP_SECRETS_SCAN = "strict";
    const big = `${"x".repeat(1000)} ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 ${"y".repeat(5 * 1024 * 1024)}`;
    const scan = scanContent(big);
    expect(scan.complete).toBe(false);
    expect(scan.safe).toBe(false);
    expect(scan.findings).toContain("GitHub Token");
  });

  test("off tier reports not-scanned and consumers must not rely on it", () => {
    process.env.MCP_SECRETS_SCAN = "off";
    const scan = scanContent("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12");
    expect(scan.complete).toBe(false);
    expect(scan.scannedBytes).toBe(0);
  });
});

describe("cache admission requires a complete scan", () => {
  afterEach(() => {
    delete process.env.MCP_SECRETS_SCAN;
    toolCache.clear();
  });

  test("oversize content is executed but never enters the shared cache", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    toolCache.clear();
    const hitsBefore = toolCache.stats.hits;
    const wrapped = wrapHandler("read_file", async () => success("x".repeat(5 * 1024 * 1024), { content: "big" }));
    await wrapped({}, undefined);
    await wrapped({}, undefined); // 若入缓存，第二次调用应命中
    expect(toolCache.stats.hits).toBe(hitsBefore);
  });

  test("scannable safe content still hits the cache", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    toolCache.clear();
    const hitsBefore = toolCache.stats.hits;
    const wrapped = wrapHandler("read_file", async () => success("small content", { content: "small" }));
    await wrapped({}, undefined);
    await wrapped({}, undefined);
    expect(toolCache.stats.hits).toBe(hitsBefore + 1);
  });

  test("environment_vars never enters the shared result cache", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    toolCache.clear();
    const hitsBefore = toolCache.stats.hits;
    const wrapped = wrapHandler("environment_vars", async () =>
      success("PATH=C:\\tools", { vars: { PATH: "C:\\tools" } }),
    );
    await wrapped({}, undefined);
    await wrapped({}, undefined);
    expect(toolCache.stats.hits).toBe(hitsBefore); // SEC-04：任意 env 值不进共享缓存
  });
});

describe("ResultBoundary redacts error exits", () => {
  test("commandBlocked/timeout keep the error usable without leaking the raw command", () => {
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ12";
    const blocked = Errors.commandBlocked(`echo ${secret}`, "dangerous pattern");
    expect(blocked.error.detail).toMatchObject({ command: `echo ${REDACTED}` });
    expect(JSON.stringify(blocked.error)).not.toContain(secret);

    const timedOut = Errors.timeout(`deploy --token ${secret}`, 1000);
    expect(JSON.stringify(timedOut.error)).not.toContain(secret);
    expect((timedOut.error.detail as Record<string, unknown>).timeout_ms).toBe(1000);
  });
});
