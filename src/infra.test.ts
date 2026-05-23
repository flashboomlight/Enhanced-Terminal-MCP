import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock safeguard before importing middleware
vi.mock("./safeguard.js", () => ({
  guardDestructiveAction: vi.fn().mockResolvedValue(null),
  initSafeGuard: vi.fn(),
}));

// Mock child_process for pool tests
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: any[]) => {
      // For stream tests with cmd.exe, use real spawn
      if (args[0] === "cmd.exe" || args[0] === "/bin/sh") {
        return actual.spawn(...(args as Parameters<typeof actual.spawn>));
      }
      // For pool tests, return mock
      const proc = {
        pid: Math.floor(Math.random() * 10000),
        killed: false,
        on: vi.fn(),
        kill: vi.fn(() => {
          proc.killed = true;
        }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { write: vi.fn(), end: vi.fn() },
      };
      return proc;
    }),
  };
});

// ====================================================================
// telemetry.ts
// ====================================================================
describe("TelemetryStore", () => {
  let telemetry: typeof import("./telemetry.js")["telemetry"];

  beforeEach(async () => {
    const mod = await import("./telemetry.js");
    telemetry = mod.telemetry;
    telemetry.reset();
  });

  const makeMetric = (
    overrides: Partial<import("./telemetry.js").ToolCallMetric> = {},
  ): import("./telemetry.js").ToolCallMetric => ({
    toolName: "test_tool",
    latency_ms: 100,
    ok: true,
    cacheHit: false,
    timestamp: Date.now(),
    ...overrides,
  });

  test("record() stores metrics", () => {
    telemetry.record(makeMetric());
    expect(telemetry.recent(1)).toHaveLength(1);
  });

  test("recent() returns last N in reverse order", () => {
    telemetry.record(makeMetric({ latency_ms: 10 }));
    telemetry.record(makeMetric({ latency_ms: 20 }));
    telemetry.record(makeMetric({ latency_ms: 30 }));
    const r = telemetry.recent(2);
    expect(r).toHaveLength(2);
    expect(r[0].latency_ms).toBe(30);
    expect(r[1].latency_ms).toBe(20);
  });

  test("aggregate() groups by toolName with correct stats", () => {
    telemetry.record(makeMetric({ toolName: "a", latency_ms: 100, ok: true, cacheHit: true }));
    telemetry.record(makeMetric({ toolName: "a", latency_ms: 200, ok: false, cacheHit: false }));
    const agg = telemetry.aggregate();
    const stats = agg.get("a")!;
    expect(stats.count).toBe(2);
    expect(stats.avgLatency).toBe(150);
    expect(stats.errorRate).toBe("50.0%");
    expect(stats.cacheHitRate).toBe("50.0%");
  });

  test("summary() returns global stats", () => {
    telemetry.record(makeMetric());
    const s = telemetry.summary();
    expect(s.total_calls).toBe(1);
    expect(s.avg_latency_ms).toBe(100);
    expect(s).toHaveProperty("uptime_minutes");
    expect(s).toHaveProperty("by_tool");
  });

  test("summaryText() returns formatted string", () => {
    telemetry.record(makeMetric({ toolName: "foo" }));
    const text = telemetry.summaryText();
    expect(text).toContain("Calls: 1");
    expect(text).toContain("foo");
  });

  test("reset() clears all metrics", () => {
    telemetry.record(makeMetric());
    telemetry.reset();
    expect(telemetry.recent(100)).toHaveLength(0);
  });

  test("maxHistory cap (1000 items)", () => {
    for (let i = 0; i < 1050; i++) {
      telemetry.record(makeMetric({ latency_ms: i }));
    }
    expect(telemetry.recent(2000)).toHaveLength(1000);
  });

  test("recentStream yields formatted lines", async () => {
    telemetry.reset();
    telemetry.record({ toolName: "x", latency_ms: 10, ok: true, cacheHit: true, timestamp: Date.now() });
    const lines: string[] = [];
    for await (const line of telemetry.recentStream(5)) lines.push(line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("x:");
    expect(lines[0]).toContain("(cached)");
  });
});

// ====================================================================
// pool.ts
// ====================================================================
describe("ProcessPool", () => {
  let ProcessPool: any;
  let pool: any;

  beforeEach(async () => {
    // Dynamically create a pool instance for testing
    const { spawn } = await import("child_process");
    // Create pool class manually to avoid singleton
    pool = {
      entries: [] as any[],
      maxSize: 4,
      idleTimeout: 60000,
      nextId: 1,
    };

    // Use the exported singleton but test via its methods
    const mod = await import("./pool.js");
    pool = mod.processPool;
  });

  afterEach(() => {
    pool.destroy();
  });

  test("acquire() creates new process when pool empty", () => {
    const entry = pool.acquire();
    expect(entry).toBeDefined();
    expect(entry.busy).toBe(true);
    expect(entry.proc).toBeDefined();
  });

  test("acquire() reuses idle process", () => {
    const entry1 = pool.acquire();
    pool.release(entry1);
    const entry2 = pool.acquire();
    expect(entry2.id).toBe(entry1.id);
  });

  test("release() marks process as not busy", () => {
    const entry = pool.acquire();
    expect(entry.busy).toBe(true);
    pool.release(entry);
    expect(entry.busy).toBe(false);
  });

  test("stats returns correct counts", () => {
    const e1 = pool.acquire();
    pool.acquire();
    pool.release(e1);
    const s = pool.stats;
    expect(s.size).toBe(2);
    expect(s.idle).toBe(1);
    expect(s.busy).toBe(1);
  });

  test("sweep() removes idle processes past timeout", () => {
    vi.useFakeTimers();
    const entry = pool.acquire();
    pool.release(entry);
    vi.advanceTimersByTime(70000);
    const removed = pool.sweep();
    expect(removed).toBe(1);
    expect(pool.stats.size).toBe(0);
    vi.useRealTimers();
  });

  test("destroy() kills all processes", () => {
    pool.acquire();
    pool.acquire();
    pool.destroy();
    expect(pool.stats.size).toBe(0);
  });

  test("acquire() creates temporary process when pool full", () => {
    // Fill pool to max (4)
    const entries = [];
    for (let i = 0; i < 4; i++) entries.push(pool.acquire());
    // All busy, pool full — should create a new temporary process (not in pool)
    const extra = pool.acquire();
    expect(extra.busy).toBe(true);
    expect(entries.some((e) => e.id === extra.id)).toBe(false); // new process, not reused
  });

  test("startSweep sets up interval", () => {
    vi.useFakeTimers();
    pool.acquire();
    pool.release(pool.acquire());
    pool.startSweep(100);
    vi.advanceTimersByTime(200);
    // Should not throw
    vi.useRealTimers();
  });
});

// ====================================================================
// stream.ts
// ====================================================================
describe("stream", () => {
  let spawnStream: typeof import("./stream.js")["spawnStream"];
  let quickExec: typeof import("./stream.js")["quickExec"];

  beforeEach(async () => {
    const mod = await import("./stream.js");
    spawnStream = mod.spawnStream;
    quickExec = mod.quickExec;
  });

  test("spawnStream executes simple command", async () => {
    const r = await spawnStream("cmd.exe", ["/c", "echo hello"], { timeout: 5000 });
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("spawnStream respects timeout", async () => {
    const r = await spawnStream("cmd.exe", ["/c", "ping -n 10 127.0.0.1"], { timeout: 500 });
    expect(r.timedOut).toBe(true);
  });

  test("quickExec returns stdout and exitCode", async () => {
    const r = await quickExec("echo hello");
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  test("spawnStream captures stderr", async () => {
    const r = await spawnStream("cmd.exe", ["/c", "echo err 1>&2"], { timeout: 5000 });
    expect(r.stderr.trim()).toBe("err");
  });

  test("spawnStream truncates output exceeding maxOutput", async () => {
    // Generate output larger than maxOutput (set to 100 bytes)
    const r = await spawnStream("cmd.exe", ["/c", "echo " + "A".repeat(200)], { timeout: 5000, maxOutput: 100 });
    expect(r.stdout.length).toBeLessThanOrEqual(120); // 100 + truncation message
    expect(r.stdout).toContain("TRUNCATED");
  });
});

// ====================================================================
// adaptive.ts
// ====================================================================
describe("adaptive", () => {
  let adaptiveTimeout: typeof import("./adaptive.js")["adaptiveTimeout"];
  let withRetry: typeof import("./adaptive.js")["withRetry"];
  let telemetry: typeof import("./telemetry.js")["telemetry"];

  beforeEach(async () => {
    const mod = await import("./adaptive.js");
    adaptiveTimeout = mod.adaptiveTimeout;
    withRetry = mod.withRetry;
    const tMod = await import("./telemetry.js");
    telemetry = tMod.telemetry;
    telemetry.reset();
  });

  test("adaptiveTimeout returns default when no history", () => {
    const t = adaptiveTimeout("execute_command");
    expect(t).toBe(30000);
  });

  test("adaptiveTimeout returns higher value when history shows high latency", () => {
    // Need 5+ records for adaptive to kick in
    for (let i = 0; i < 10; i++) {
      telemetry.record({
        toolName: "execute_command",
        latency_ms: 20000,
        ok: true,
        cacheHit: false,
        timestamp: Date.now(),
      });
    }
    const t = adaptiveTimeout("execute_command");
    expect(t).toBeGreaterThan(30000);
  });

  test("withRetry succeeds on first try", async () => {
    const result = await withRetry(async () => "ok", { maxRetries: 3, baseDelay: 1 });
    expect(result).toBe("ok");
  });

  test("withRetry retries on failure and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("fail");
        return "ok";
      },
      { maxRetries: 3, baseDelay: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("withRetry throws after maxRetries exhausted", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("always fail");
        },
        { maxRetries: 2, baseDelay: 1 },
      ),
    ).rejects.toThrow("always fail");
  });
});
