import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ============================================================
// cache.ts
// ============================================================
import { LRUCache } from "../../src/cache.js";

describe("LRUCache", () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new LRUCache<string>(3, 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("get/set basic", () => {
    cache.set("a", "1");
    expect(cache.get("a")).toEqual({ value: "1", fromCache: true });
    expect(cache.get("miss")).toBeNull();
  });

  test("TTL expiration", () => {
    cache.set("a", "1");
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeNull();
  });

  test("LRU eviction when maxSize reached", () => {
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    // access "a" to make it recent
    cache.get("a");
    // insert "d" — should evict "b" (oldest untouched)
    cache.set("d", "4");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")).not.toBeNull();
  });

  test("invalidate single key", () => {
    cache.set("a", "1");
    expect(cache.invalidate("a")).toBe(true);
    expect(cache.get("a")).toBeNull();
  });

  test("invalidatePrefix", () => {
    cache.set("tool:1", "x");
    cache.set("tool:2", "y");
    cache.set("other:1", "z");
    expect(cache.invalidatePrefix("tool:")).toBe(2);
    expect(cache.get("other:1")).not.toBeNull();
  });

  test("stats tracks hits and misses", () => {
    cache.set("a", "1");
    cache.get("a"); // hit
    cache.get("b"); // miss
    const s = cache.stats;
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRate).toBe("50.0%");
  });

  test("stats hitRate is N/A when no gets performed", () => {
    const fresh = new LRUCache<string>(3, 1000);
    expect(fresh.stats.hitRate).toBe("N/A");
  });

  test("clear empties cache", () => {
    cache.set("a", "1");
    cache.clear();
    expect(cache.get("a")).toBeNull();
    expect(cache.stats.size).toBe(0);
  });

  test("static key() builds tool:args string", () => {
    const k = LRUCache.key("read_file", { path: "/tmp" });
    expect(k).toBe('read_file:{"path":"/tmp"}');
  });

  test("get refreshes sliding TTL", () => {
    cache.set("a", "1");
    vi.advanceTimersByTime(800);
    expect(cache.get("a")).not.toBeNull(); // hit resets TTL
    vi.advanceTimersByTime(800);
    expect(cache.get("a")).not.toBeNull(); // still within new TTL
    vi.advanceTimersByTime(1001);
    expect(cache.get("a")).toBeNull();
  });

  test("evicts by memory budget", () => {
    const small = new LRUCache<string>(10, 60000, 20); // 20 bytes max
    small.set("a", "xxxxxxxxxxxxxxxxxxxx"); // ~20 bytes
    small.set("b", "yyyyyyyyyyyyyyyyyyyy");
    // second insert should force eviction of first under memory cap
    expect(small.stats.size).toBeLessThanOrEqual(1);
    expect(small.stats.approxBytes).toBeLessThanOrEqual(20);
  });
});

// ============================================================
// result.ts
// ============================================================
import { ErrorCode, Errors, fail, success, toCallToolResult } from "../../src/result.js";

describe("result", () => {
  test("success() returns correct structure", () => {
    const r = success("ok", { x: 1 });
    expect(r.ok).toBe(true);
    expect(r.content).toBe("ok");
    expect(r.structured).toEqual({ x: 1 });
  });

  test("fail() returns correct structure with error code", () => {
    const r = fail(ErrorCode.TIMEOUT, "timed out", { retryable: true });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("TIMEOUT");
    expect(r.error.retryable).toBe(true);
    expect(r.content).toContain("[TIMEOUT]");
  });

  test("toCallToolResult converts success", () => {
    const r = toCallToolResult(success("hi", { a: 1 }));
    expect((r.content[0] as any).text).toBe("hi");
    expect((r as any).isError).toBeUndefined();
  });

  test("toCallToolResult omits structuredContent when structured is undefined", () => {
    const r = toCallToolResult({ ok: true, content: "hi", structured: undefined } as any);
    expect((r as any).structuredContent).toBeUndefined();
  });

  test("toCallToolResult converts error with isError=true", () => {
    const r = toCallToolResult(fail(ErrorCode.PATH_NOT_FOUND, "nope"));
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toContain("[PATH_NOT_FOUND]");
  });

  test("Errors.pathTraversal", () => {
    const r = Errors.pathTraversal("../etc");
    expect(r.error.code).toBe("PATH_TRAVERSAL");
  });

  test("Errors.pathForbidden", () => {
    const r = Errors.pathForbidden("C:\\Windows");
    expect(r.error.code).toBe("PATH_FORBIDDEN");
  });

  test("Errors.timeout", () => {
    const r = Errors.timeout("sleep 99", 5000);
    expect(r.error.code).toBe("TIMEOUT");
    expect(r.error.retryable).toBe(true);
  });

  test("Errors.pathSensitive", () => {
    const r = Errors.pathSensitive(".env");
    expect(r.error.code).toBe("PATH_SENSITIVE");
  });

  test("Errors.pathNotFound", () => {
    const r = Errors.pathNotFound("/missing");
    expect(r.error.code).toBe("PATH_NOT_FOUND");
    expect(r.error.retryable).toBe(true);
  });

  test("Errors.pathEmpty", () => {
    const r = Errors.pathEmpty();
    expect(r.error.code).toBe("PATH_EMPTY");
  });

  test("Errors.commandDangerous", () => {
    const r = Errors.commandDangerous("rm -rf /", "rm -rf");
    expect(r.error.code).toBe("COMMAND_DANGEROUS");
  });

  test("Errors.validationError", () => {
    const r = Errors.validationError("bad input", "name", "fix it");
    expect(r.error.code).toBe("VALIDATION_ERROR");
    expect(r.error.suggestion).toBe("fix it");
  });

  test("Errors.processProtected", () => {
    const r = Errors.processProtected("csrss");
    expect(r.error.code).toBe("PROCESS_PROTECTED");
  });

  test("Errors.safetyBlocked", () => {
    const r = Errors.safetyBlocked("delete_path", "strict mode");
    expect(r.error.code).toBe("SAFETY_BLOCKED");
  });

  test("Errors.executionFailed", () => {
    const r = Errors.executionFailed("oops", { detail: 1 });
    expect(r.error.code).toBe("EXECUTION_FAILED");
    expect(r.error.retryable).toBe(true);
  });

  test("Errors.internalError", () => {
    const r = Errors.internalError("crash");
    expect(r.error.code).toBe("INTERNAL_ERROR");
    expect(r.error.retryable).toBe(false);
  });

  test("Errors.urlInvalid", () => {
    const r = Errors.urlInvalid("ftp://x", "not http");
    expect(r.error.code).toBe("URL_INVALID");
  });

  test("Errors.hostInvalid", () => {
    const r = Errors.hostInvalid("evil.com", "blocked");
    expect(r.error.code).toBe("HOST_INVALID");
  });
});

// ============================================================
// session.ts
// ============================================================
import { session } from "../../src/session.js";

describe("SessionStore", () => {
  beforeEach(() => session.reset());

  test("get() returns state copy", () => {
    const a = session.get();
    const b = session.get();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  test("setCwd/getCwd", () => {
    session.setCwd("/tmp");
    expect(session.getCwd()).toBe("/tmp");
  });

  test("setEnv/getEnv", () => {
    session.setEnv("FOO", "bar");
    expect(session.getEnv("FOO")).toBe("bar");
    expect(session.getEnv("NOPE")).toBeUndefined();
  });

  test("pushHistory and 50-item cap", () => {
    for (let i = 0; i < 55; i++) session.pushHistory(`cmd${i}`);
    expect(session.get().history.length).toBe(50);
    expect(session.lastCommand()).toBe("cmd54");
  });

  test("lastCommand returns undefined when empty", () => {
    expect(session.lastCommand()).toBeUndefined();
  });

  test("reset clears state", () => {
    session.setCwd("/x");
    session.setEnv("K", "V");
    session.pushHistory("ls");
    session.reset();
    expect(session.getEnv("K")).toBeUndefined();
    expect(session.get().history.length).toBe(0);
  });

  test("snapshot returns JSON", () => {
    session.setCwd("/home");
    const snap = JSON.parse(session.snapshot());
    expect(snap.cwd).toBe("/home");
    expect(snap).toHaveProperty("envKeys");
    expect(snap).toHaveProperty("historyLength");
  });

  test("reset does not corrupt DEFAULT_STATE", () => {
    session.setEnv("A", "1");
    session.pushHistory("x");
    session.reset();
    session.reset(); // double reset
    expect(session.get().env).toEqual({});
    expect(session.get().history).toEqual([]);
  });
});

// ============================================================
// scan.ts
// ============================================================
import { isCredentialFilePath, scanContent } from "../../src/scan.js";

describe("scanContent", () => {
  test("detects OpenAI key", () => {
    const r = scanContent("key=sk-abcdefghijklmnopqrstuvwxyz012345");
    expect(r.safe).toBe(false);
    expect(r.findings).toContain("OpenAI API Key");
  });

  test("skips short sk- placeholders", () => {
    const r = scanContent("docs use sk-test-key-example only");
    expect(r.findings).not.toContain("OpenAI API Key");
  });

  test("detects GitHub token", () => {
    const r = scanContent("token=ghp_1234567890abcdefghij");
    expect(r.safe).toBe(false);
    expect(r.findings).toContain("GitHub Token");
  });

  test("detects AWS key", () => {
    const r = scanContent("AKIAIOSFODNN7EXAMPLE");
    expect(r.safe).toBe(false);
    expect(r.findings).toContain("AWS Access Key");
  });

  test("detects private key header", () => {
    const r = scanContent("-----BEGIN RSA PRIVATE KEY-----");
    expect(r.safe).toBe(false);
    expect(r.findings).toContain("Private Key Header");
  });

  test("returns safe for normal content", () => {
    const r = scanContent("hello world\nconst x = 42;");
    expect(r.safe).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});

describe("isCredentialFilePath", () => {
  test("detects .env", () => expect(isCredentialFilePath(".env")).toBe(true));
  test("detects .env.local", () => expect(isCredentialFilePath(".env.local")).toBe(true));
  test("detects .pem", () => expect(isCredentialFilePath("cert.pem")).toBe(true));
  test("detects .ssh/", () => expect(isCredentialFilePath("/home/user/.ssh/id_rsa")).toBe(true));
  test("returns false for normal paths", () => {
    expect(isCredentialFilePath("src/index.ts")).toBe(false);
    expect(isCredentialFilePath("README.md")).toBe(false);
  });
});

// ============================================================
// regex.ts
// ============================================================
import { getRegex, regexCache } from "../../src/regex.js";

describe("getRegex", () => {
  beforeEach(() => regexCache.clear());

  test("returns equivalent regex on second call", () => {
    const a = getRegex("foo");
    const b = getRegex("foo");
    expect(a.source).toBe(b.source);
    expect(a.flags).toBe(b.flags);
    expect(a).not.toBe(b); // new instance each time to avoid lastIndex leaks
  });

  test("lastIndex is reset on cached retrieval", () => {
    const re = getRegex("x", "g");
    re.lastIndex = 5;
    const re2 = getRegex("x", "g");
    expect(re2.lastIndex).toBe(0);
  });

  test("different flags create different cache entries", () => {
    const a = getRegex("foo", "g");
    const b = getRegex("foo", "i");
    expect(a).not.toBe(b);
  });
});

// ============================================================
// context.ts
// ============================================================
import { contextSuffix, injectContext } from "../../src/context.js";

describe("context", () => {
  beforeEach(() => session.reset());

  test("contextSuffix includes cwd", () => {
    session.setCwd("/test");
    expect(contextSuffix()).toContain('cwd="/test"');
  });

  test("contextSuffix includes env keys when set", () => {
    session.setEnv("NODE_ENV", "prod");
    expect(contextSuffix()).toContain("NODE_ENV");
  });

  test("contextSuffix includes last command when history exists", () => {
    session.pushHistory("git status");
    expect(contextSuffix()).toContain('last_cmd="git status"');
  });

  test("injectContext appends suffix to description", () => {
    session.setCwd("/app");
    const result = injectContext("Run a command");
    expect(result).toMatch(/^Run a command\n\[Session:/);
  });
});
