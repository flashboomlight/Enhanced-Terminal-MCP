/**
 * command-output.ts 单元测试（S1: limits 校验 + 纯内存路径）
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  type CommandOutputLimits,
  getCommandOutputLimits,
  resetCommandOutputLimitsCache,
  runCommandOutput,
} from "../../src/command-output.js";

const LIMIT_VARS = [
  "MCP_COMMAND_MEMORY_OUTPUT_BYTES",
  "MCP_COMMAND_MAX_OUTPUT_BYTES",
  "MCP_COMMAND_MAX_STDERR_BYTES",
  "MCP_TEMP_MAX_TOTAL_BYTES",
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const v of LIMIT_VARS) ORIGINAL_ENV[v] = process.env[v];
ORIGINAL_ENV.MCP_SECRETS_SCAN = process.env.MCP_SECRETS_SCAN;

afterEach(() => {
  for (const v of LIMIT_VARS) {
    const orig = ORIGINAL_ENV[v];
    if (orig === undefined) delete process.env[v];
    else process.env[v] = orig;
  }
  const origScan = ORIGINAL_ENV.MCP_SECRETS_SCAN;
  if (origScan === undefined) delete process.env.MCP_SECRETS_SCAN;
  else process.env.MCP_SECRETS_SCAN = origScan;
  resetCommandOutputLimitsCache();
});

function clearLimitVars(): void {
  for (const v of LIMIT_VARS) delete process.env[v];
}

describe("getCommandOutputLimits", () => {
  test("defaults when unset", () => {
    clearLimitVars();
    const { limits, error } = getCommandOutputLimits();
    expect(error).toBeNull();
    expect(limits).toEqual({
      memoryOutputBytes: 1048576,
      maxStdoutBytes: 52428800,
      maxStderrBytes: 1048576,
      tempMaxTotalBytes: 1073741824,
    });
  });

  test("accepts valid custom values", () => {
    clearLimitVars();
    process.env.MCP_COMMAND_MEMORY_OUTPUT_BYTES = "2048";
    process.env.MCP_COMMAND_MAX_OUTPUT_BYTES = "4096";
    process.env.MCP_COMMAND_MAX_STDERR_BYTES = "1024";
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "8192";
    const { limits, error } = getCommandOutputLimits();
    expect(error).toBeNull();
    expect(limits).toEqual({
      memoryOutputBytes: 2048,
      maxStdoutBytes: 4096,
      maxStderrBytes: 1024,
      tempMaxTotalBytes: 8192,
    });
  });

  test("invalid integers rejected per variable", () => {
    for (const v of LIMIT_VARS) {
      clearLimitVars();
      resetCommandOutputLimitsCache();
      for (const bad of ["abc", "1.5", "-5", "0", "10MB"]) {
        process.env[v] = bad;
        resetCommandOutputLimitsCache();
        const { limits, error } = getCommandOutputLimits();
        expect(limits).toBeNull();
        expect(error).toContain(v);
        delete process.env[v];
      }
    }
  });

  test("relationship invalid: memory threshold above combined retained caps", () => {
    clearLimitVars();
    process.env.MCP_COMMAND_MEMORY_OUTPUT_BYTES = "3000";
    process.env.MCP_COMMAND_MAX_OUTPUT_BYTES = "2000";
    process.env.MCP_COMMAND_MAX_STDERR_BYTES = "999";
    const { limits, error } = getCommandOutputLimits();
    expect(limits).toBeNull();
    expect(error).toContain("MCP_COMMAND_MEMORY_OUTPUT_BYTES");
  });

  test("relationship boundary: memory threshold equal to combined caps is valid", () => {
    clearLimitVars();
    process.env.MCP_COMMAND_MEMORY_OUTPUT_BYTES = "2999";
    process.env.MCP_COMMAND_MAX_OUTPUT_BYTES = "2000";
    process.env.MCP_COMMAND_MAX_STDERR_BYTES = "999";
    const { limits, error } = getCommandOutputLimits();
    expect(error).toBeNull();
    expect(limits?.memoryOutputBytes).toBe(2999);
  });

  test("process-level cache: env change requires reset to take effect", () => {
    clearLimitVars();
    process.env.MCP_COMMAND_MAX_OUTPUT_BYTES = "not-a-number";
    const first = getCommandOutputLimits();
    expect(first.error).toContain("MCP_COMMAND_MAX_OUTPUT_BYTES");
    delete process.env.MCP_COMMAND_MAX_OUTPUT_BYTES;
    const stillCached = getCommandOutputLimits();
    expect(stillCached.error).toContain("MCP_COMMAND_MAX_OUTPUT_BYTES");
    resetCommandOutputLimitsCache();
    const afterReset = getCommandOutputLimits();
    expect(afterReset.error).toBeNull();
    expect(afterReset.limits?.maxStdoutBytes).toBe(52428800);
  });
});

describe("runCommandOutput", () => {
  const limits: CommandOutputLimits = {
    memoryOutputBytes: 1048576,
    maxStdoutBytes: 52428800,
    maxStderrBytes: 1048576,
    tempMaxTotalBytes: 1073741824,
  };

  test("small output memory path", async () => {
    const r = await runCommandOutput("node", ["-e", "console.log('hello')"], { limits });
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.stderrTruncated).toBe(false);
    expect(r.stdoutActualBytes).toBe(6);
    expect(r.stdoutRetainedBytes).toBe(6);
  });

  test("non-zero exit code preserved", async () => {
    const r = await runCommandOutput("node", ["-e", "process.exit(3)"], { limits });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  test("timeout propagates", async () => {
    const r = await runCommandOutput("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeout: 100, limits });
    expect(r.timedOut).toBe(true);
  });

  test("stdout cap: drain without kill, retained stops at cap", async () => {
    const tight: CommandOutputLimits = { ...limits, maxStdoutBytes: 4096 };
    const size = 100000;
    const r = await runCommandOutput("node", ["-e", `process.stdout.write('x'.repeat(${size}))`], { limits: tight });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.stdoutActualBytes).toBe(size);
    expect(r.stdoutRetainedBytes).toBe(4096);
    expect(r.stdout.endsWith("\n... (TRUNCATED)")).toBe(true);
    expect(r.stdout.startsWith("xxxx")).toBe(true);
  });

  test("stderr cap: silent truncation tracked separately", async () => {
    const tight: CommandOutputLimits = { ...limits, maxStderrBytes: 2048 };
    const size = 10000;
    const r = await runCommandOutput("node", ["-e", `process.stderr.write('e'.repeat(${size}))`], { limits: tight });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.stderrTruncated).toBe(true);
    expect(r.stderrActualBytes).toBe(size);
    expect(r.stderrRetainedBytes).toBe(2048);
    expect(r.stderr.length).toBe(2048);
  });

  test("spawn failure throws (Node semantics)", async () => {
    await expect(runCommandOutput("nonexistent_command_xyz", [], { limits })).rejects.toThrow();
  });
});

describe("secret scan tiers (S2)", () => {
  const limits: CommandOutputLimits = {
    memoryOutputBytes: 1048576,
    maxStdoutBytes: 52428800,
    maxStderrBytes: 1048576,
    tempMaxTotalBytes: 1073741824,
  };

  test("cache tier: secret suppressed with facts preserved", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    const r = await runCommandOutput("node", ["-e", "process.stdout.write('sk-'+'x'.repeat(32))"], { limits });
    expect(r.secretDetected).toBe(true);
    expect(r.secretTier).toBe("cache");
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.stdoutRetainedBytes).toBe(0);
    expect(r.stderrRetainedBytes).toBe(0);
    expect(r.stdoutActualBytes).toBe(35);
    expect(r.truncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdoutFallbackPreview.length).toBe(0);
    expect(r.stderrFallbackPreview.length).toBe(0);
  });

  test("strict tier: suppressed, tier reported", async () => {
    process.env.MCP_SECRETS_SCAN = "strict";
    const r = await runCommandOutput("node", ["-e", "process.stdout.write('ghp_'+'y'.repeat(20))"], { limits });
    expect(r.secretDetected).toBe(true);
    expect(r.secretTier).toBe("strict");
    expect(r.stdout).toBe("");
  });

  test("off tier: pass-through without scanning", async () => {
    process.env.MCP_SECRETS_SCAN = "off";
    const secret = `sk-${"x".repeat(32)}`;
    const r = await runCommandOutput("node", ["-e", `process.stdout.write('${secret}')`], { limits });
    expect(r.secretDetected).toBe(false);
    expect(r.secretTier).toBeNull();
    expect(r.stdout).toBe(secret);
    expect(r.stdoutRetainedBytes).toBe(35);
  });

  test("write tier: memory phase does not scan (spill-path scan lands in S3)", async () => {
    process.env.MCP_SECRETS_SCAN = "write";
    const secret = `sk-${"x".repeat(32)}`;
    const r = await runCommandOutput("node", ["-e", `process.stdout.write('${secret}')`], { limits });
    expect(r.secretDetected).toBe(false);
    expect(r.stdout).toBe(secret);
  });

  test("fallback preview keeps first 65536 released bytes on clean path", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    const size = 100000;
    const r = await runCommandOutput("node", ["-e", `process.stdout.write('q'.repeat(${size}))`], { limits });
    expect(r.secretDetected).toBe(false);
    expect(r.stdoutFallbackPreview.length).toBe(65536);
    expect(r.stdoutFallbackPreview.toString("latin1")).toBe("q".repeat(65536));
    expect(r.stdoutActualBytes).toBe(size);
  });

  test("secret after clean prefix: fallback buffers cleared, actual complete", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    const prefix = 70000;
    const r = await runCommandOutput(
      "node",
      ["-e", `process.stdout.write('q'.repeat(${prefix})+'sk-'+'x'.repeat(32))`],
      { limits },
    );
    expect(r.secretDetected).toBe(true);
    expect(r.stdout).toBe("");
    expect(r.stdoutFallbackPreview.length).toBe(0);
    expect(r.stdoutActualBytes).toBe(prefix + 35);
    expect(r.stdoutRetainedBytes).toBe(0);
    expect(r.truncated).toBe(true);
  });

  test("stderr secret suppresses stdout too (dual-stream suppression)", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    const r = await runCommandOutput(
      "node",
      ["-e", "process.stdout.write('clean out');process.stderr.write('sk-'+'x'.repeat(32))"],
      { limits },
    );
    expect(r.secretDetected).toBe(true);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.stdoutActualBytes).toBe(9);
    expect(r.stderrActualBytes).toBe(35);
    expect(r.truncated).toBe(true);
    expect(r.stderrTruncated).toBe(true);
  });

  test("undecided candidate overflow fail-closed", async () => {
    process.env.MCP_SECRETS_SCAN = "cache";
    const r = await runCommandOutput("node", ["-e", "process.stdout.write('M'+'A'.repeat(9000))"], { limits });
    expect(r.secretDetected).toBe(true);
    expect(r.stdout).toBe("");
    expect(r.stdoutActualBytes).toBe(9001);
  });
});
