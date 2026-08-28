/**
 * command-budget 单元测试：预算常量、parent/child ledger 语义、deadline 分类与输入二次校验
 */
import { describe, expect, test } from "vitest";
import {
  buildBatchBudget,
  commandBudgetSkipReason,
  commandInputBytes,
  MAX_BATCH_INPUT_BYTES,
  MAX_BATCH_ITEMS,
  MAX_BATCH_OUTPUT_BYTES,
  MAX_BATCH_WALLTIME_MS,
  MAX_COMMAND_BYTES,
  MAX_COMMAND_CHARS,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_WATCH_DURATION_MS,
  validateBoundedCommandInput,
} from "../../src/command-budget.js";

describe("buildBatchBudget", () => {
  test("uses production constants by default and arms a future deadline", () => {
    const budget = buildBatchBudget();
    expect(budget.scope).toBe("batch");
    expect(budget.remaining("input")).toBe(MAX_BATCH_INPUT_BYTES);
    expect(budget.remaining("output")).toBe(MAX_BATCH_OUTPUT_BYTES);
    expect(budget.deadlineAt).toBeGreaterThan(Date.now());
    expect(budget.deadlineAt).toBeLessThanOrEqual(Date.now() + MAX_BATCH_WALLTIME_MS + 50);
    budget.close();
  });

  test("allows tests to inject small overrides", () => {
    const budget = buildBatchBudget(undefined, { input: 100, output: 200, walltimeMs: 5000 });
    expect(budget.remaining("input")).toBe(100);
    expect(budget.remaining("output")).toBe(200);
    budget.close();
  });

  test("reserves deduct the shared parent ledger across children", () => {
    const budget = buildBatchBudget(undefined, { input: 1000, output: 1000 });
    const child = budget.child("child");
    expect(child.reserve("input", 400)).toBe(true);
    expect(budget.remaining("input")).toBe(600);
    expect(child.reserve("input", 700)).toBe(false);
    expect(budget.reserve("output", 999)).toBe(true);
    expect(child.remaining("output")).toBe(1);
    budget.close();
  });

  test("concurrent reserves on one ledger never overshoot the limit", async () => {
    const budget = buildBatchBudget(undefined, { input: 1000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve().then(() => budget.reserve("input", 30))),
    );
    const accepted = results.filter(Boolean).length;
    expect(accepted).toBe(33);
    expect(budget.remaining("input")).toBeLessThan(30);
    budget.close();
  });

  test("an expired wall-time aborts the ledger and classifies as budget_deadline", () => {
    const budget = buildBatchBudget(undefined, { walltimeMs: 0 });
    expect(budget.abortSignal.aborted).toBe(true);
    expect(commandBudgetSkipReason(budget)).toBe("budget_deadline");
  });

  test("an active budget without deadline expiry has no skip classification", () => {
    const budget = buildBatchBudget();
    expect(budget.abortSignal.aborted).toBe(false);
    expect(commandBudgetSkipReason(budget)).toBeNull();
    budget.close();
  });

  test("an external abort signal propagates to the budget ledger", () => {
    const controller = new AbortController();
    const budget = buildBatchBudget(controller.signal, { walltimeMs: 5000 });
    expect(budget.abortSignal.aborted).toBe(false);
    controller.abort();
    expect(budget.abortSignal.aborted).toBe(true);
    expect(commandBudgetSkipReason(budget)).toBeNull();
  });
});

describe("commandInputBytes", () => {
  test("counts UTF-8 bytes rather than characters", () => {
    expect(commandInputBytes("abc")).toBe(3);
    expect(commandInputBytes("中")).toBe(3);
    expect(commandInputBytes("中".repeat(2))).toBe(6);
  });
});

describe("validateBoundedCommandInput", () => {
  test("accepts ordinary inputs", () => {
    expect(validateBoundedCommandInput({ command: "echo hi", timeout: 30000 })).toBeNull();
    expect(validateBoundedCommandInput({ commands: ["echo a", "echo b"] })).toBeNull();
    expect(validateBoundedCommandInput({})).toBeNull();
  });

  test("rejects non-finite and out-of-range timeout/duration", () => {
    expect(validateBoundedCommandInput({ timeout: Number.POSITIVE_INFINITY })).toMatch(/timeout/);
    expect(validateBoundedCommandInput({ timeout: Number.NaN })).toMatch(/timeout/);
    expect(validateBoundedCommandInput({ timeout: 0 })).toMatch(/timeout/);
    expect(validateBoundedCommandInput({ timeout: -1 })).toMatch(/timeout/);
    expect(validateBoundedCommandInput({ timeout: MAX_COMMAND_TIMEOUT_MS + 1 })).toMatch(/timeout/);
    expect(validateBoundedCommandInput({ duration: Number.POSITIVE_INFINITY })).toMatch(/duration/);
    expect(validateBoundedCommandInput({ duration: MAX_WATCH_DURATION_MS + 1 })).toMatch(/duration/);
  });

  test("rejects oversized commands by chars and UTF-8 bytes", () => {
    expect(validateBoundedCommandInput({ command: "a".repeat(MAX_COMMAND_CHARS + 1) })).toMatch(/command/);
    const bytesOver = "中".repeat(Math.floor(MAX_COMMAND_BYTES / 3) + 1);
    expect(commandInputBytes(bytesOver)).toBeGreaterThan(MAX_COMMAND_BYTES);
    expect(validateBoundedCommandInput({ command: bytesOver })).toMatch(/command/);
  });

  test("rejects oversized batch arrays and items", () => {
    expect(
      validateBoundedCommandInput({ commands: Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => "echo") }),
    ).toMatch(/commands/);
    expect(validateBoundedCommandInput({ commands: ["a".repeat(MAX_COMMAND_BYTES + 1)] })).toMatch(/each command/);
  });

  test("rejects non-string values fail-closed", () => {
    expect(validateBoundedCommandInput({ command: 42 as unknown as string })).toMatch(/command/);
    expect(validateBoundedCommandInput({ commands: "echo" as unknown as string[] })).toMatch(/commands/);
  });
});
