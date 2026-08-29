import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { IS_WIN } from "../../src/platform.js";

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
      // For stream/shell-spec tests with real executables (cmd/sh/PowerShell), use real spawn
      if (
        args[0] === "cmd.exe" ||
        args[0] === "/bin/sh" ||
        /(?:^|[\\/])(?:powershell|pwsh)\.exe$/i.test(String(args[0]))
      ) {
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
  let telemetry: typeof import("../../src/telemetry.js")["telemetry"];

  beforeEach(async () => {
    const mod = await import("../../src/telemetry.js");
    telemetry = mod.telemetry;
    telemetry.reset();
  });

  const makeMetric = (
    overrides: Partial<import("../../src/telemetry.js").ToolCallMetric> = {},
  ): import("../../src/telemetry.js").ToolCallMetric => ({
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
    const stats = agg.get("a");
    expect(stats).toBeDefined();
    if (!stats) throw new Error("stats missing");
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
  let pool: {
    stats: { size: number; max: number; idle: number; busy: number; active: boolean };
    startSweep: (ms?: number) => void;
    destroy: () => void;
  };

  beforeEach(async () => {
    const mod = await import("../../src/pool.js");
    pool = mod.processPool;
  });

  afterEach(() => {
    pool.destroy();
  });

  test("pool is inactive stub — stats always empty", () => {
    const s = pool.stats;
    expect(s.size).toBe(0);
    expect(s.idle).toBe(0);
    expect(s.busy).toBe(0);
    expect(s.max).toBe(4);
    expect(s.active).toBe(false);
  });

  test("startSweep / destroy are no-ops that do not throw", () => {
    expect(() => pool.startSweep(100)).not.toThrow();
    expect(() => pool.destroy()).not.toThrow();
    expect(pool.stats.size).toBe(0);
  });

  test("does not expose acquire/release (dead API removed)", () => {
    expect((pool as { acquire?: unknown }).acquire).toBeUndefined();
    expect((pool as { release?: unknown }).release).toBeUndefined();
  });
});

// ====================================================================
// stream.ts
// ====================================================================
describe("stream", () => {
  let spawnStream: typeof import("../../src/stream.js")["spawnStream"];
  let quickExec: typeof import("../../src/stream.js")["quickExec"];

  beforeAll(async () => {
    const mod = await import("../../src/stream.js");
    spawnStream = mod.spawnStream;
    quickExec = mod.quickExec;
    // 预热 shell 解析（仅一次）：Windows runner 上首次 PATH/版本探测在并行负载下可能
    // 超过 15s，per-test 预热会把每个用例的钩子拖超时；解析逻辑由 shell.test.ts 覆盖
    await (await import("../../src/shell.js")).getShellSpec();
  }, 120000);

  // spawnStream 机制用例按平台选真实 shell（上方 spawn mock 仅对 cmd.exe//bin/sh/PowerShell 放行真实 spawn）
  const shellCmd = (cmd: string): [string, string[]] => (IS_WIN ? ["cmd.exe", ["/c", cmd]] : ["/bin/sh", ["-c", cmd]]);

  test("spawnStream executes simple command", async () => {
    const r = await spawnStream(...shellCmd("echo hello"), { timeout: 5000 });
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  // 超时行为由 stream.test.ts 覆盖（Windows 上 kill 路径与并行负载下 infra 重复测易挂）

  test("quickExec returns stdout and exitCode", async () => {
    const r = await quickExec("echo hello");
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  }, 60000);

  test("spawnStream captures stderr", async () => {
    const r = await spawnStream(...shellCmd("echo err 1>&2"), { timeout: 5000 });
    expect(r.stderr.trim()).toBe("err");
  });

  test("spawnStream truncates output exceeding maxOutput", async () => {
    // Generate output larger than maxOutput (set to 100 bytes)
    const r = await spawnStream(...shellCmd(`echo ${"A".repeat(200)}`), { timeout: 5000, maxOutput: 100 });
    expect(r.stdout.length).toBeLessThanOrEqual(120); // 100 + truncation message
    expect(r.stdout).toContain("TRUNCATED");
  });
});

// ====================================================================
// adaptive.ts
// ====================================================================
describe("adaptive", () => {
  let adaptiveTimeout: typeof import("../../src/adaptive.js")["adaptiveTimeout"];
  let withRetry: typeof import("../../src/adaptive.js")["withRetry"];
  let telemetry: typeof import("../../src/telemetry.js")["telemetry"];

  beforeEach(async () => {
    const mod = await import("../../src/adaptive.js");
    adaptiveTimeout = mod.adaptiveTimeout;
    withRetry = mod.withRetry;
    const tMod = await import("../../src/telemetry.js");
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
  }, 10000);

  test("withRetry throws after maxRetries exhausted", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("always fail");
        },
        { maxRetries: 2, baseDelay: 1 },
      ),
    ).rejects.toThrow("always fail");
  }, 10000);
});
