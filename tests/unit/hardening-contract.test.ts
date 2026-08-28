import { afterEach, describe, expect, test, vi } from "vitest";
import * as z from "zod";
import {
  BudgetAccount,
  type BudgetLimits,
  boundedArray,
  boundedString,
  finiteInt,
  finiteNumber,
  parseStrictInteger,
} from "../../src/hardening-contract.js";
import {
  assertProfileAvailable,
  capabilityGate,
  createCapabilityPolicy,
  createRequestContext,
  getActiveExecutionProfile,
  initializeExecutionProfile,
  readExecutionProfile,
} from "../../src/profile.js";
import { ErrorCode, Errors } from "../../src/result.js";
import { envInt } from "../../src/utils.js";

const budgetLimits: BudgetLimits = {
  max: {
    input: 100,
    output: 10,
    disk: 100,
    queue: 10,
    process: 2,
    response: 100,
  },
  deadlineAt: Date.now() + 60_000,
};

describe("hardening contract", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("finite schemas reject non-finite and non-integral values", () => {
    const numberSchema = finiteNumber(0, 10);
    const intSchema = finiteInt(0, 10);
    expect(numberSchema.safeParse(Infinity).success).toBe(false);
    expect(numberSchema.safeParse(-Infinity).success).toBe(false);
    expect(numberSchema.safeParse(NaN).success).toBe(false);
    expect(numberSchema.safeParse(1.5).success).toBe(true);
    expect(intSchema.safeParse(1.5).success).toBe(false);
    expect(intSchema.safeParse(-1).success).toBe(false);
    expect(intSchema.safeParse(10).success).toBe(true);
  });

  test("bounded string and array helpers enforce character, byte and count limits", () => {
    const text = boundedString(4, 8);
    expect(text.safeParse("😀😀").success).toBe(true);
    expect(boundedString(4, 4).safeParse("😀😀").success).toBe(false);
    expect(boundedArray(z.string(), 2).safeParse(["a", "b"]).success).toBe(true);
    expect(boundedArray(z.string(), 2).safeParse(["a", "b", "c"]).success).toBe(false);
  });

  test("strict integer parser rejects prefix, scientific notation and overflow", () => {
    expect(parseStrictInteger(" 42 ", { name: "LIMIT", min: 1, max: 100 })).toBe(42);
    expect(parseStrictInteger(undefined, { name: "LIMIT", defaultValue: 7, min: 1, max: 100 })).toBe(7);
    for (const value of ["100evil", "1e3", "-1", "Infinity", "9007199254740992"]) {
      expect(() => parseStrictInteger(value, { name: "LIMIT", min: 1, max: Number.MAX_SAFE_INTEGER })).toThrow();
    }
  });

  test("envInt no longer accepts numeric prefixes or unsafe values", () => {
    const key = "ETM_HARDENING_TEST_INT";
    const previous = process.env[key];
    try {
      process.env[key] = "100evil";
      expect(envInt(key, 7, 1, 100)).toBe(7);
      process.env[key] = "9007199254740992";
      expect(envInt(key, 7, 1, Number.MAX_SAFE_INTEGER)).toBe(7);
      process.env[key] = "42";
      expect(envInt(key, 7, 1, 100)).toBe(42);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  test("profile parser is exact and unavailable sandbox fails closed", () => {
    expect(readExecutionProfile({})).toBe("local-trusted-shell");
    expect(readExecutionProfile({ MCP_EXECUTION_PROFILE: "sandboxed-production" })).toBe("sandboxed-production");
    expect(() => readExecutionProfile({ MCP_EXECUTION_PROFILE: "LOCAL-TRUSTED-SHELL" })).toThrow();
    expect(() => readExecutionProfile({ MCP_EXECUTION_PROFILE: "" })).toThrow();
    expect(() => readExecutionProfile({ MCP_EXECUTION_PROFILE: " ".repeat(100) })).toThrow();
    try {
      readExecutionProfile({ MCP_EXECUTION_PROFILE: "unknown" });
    } catch (error) {
      expect(error).toMatchObject({ code: "CONFIG_INVALID", param: "MCP_EXECUTION_PROFILE" });
    }
    expect(() => assertProfileAvailable("sandboxed-production")).toThrowError(
      /Execution profile is unavailable: sandboxed-production/,
    );
  });

  test("initialized profile remains stable instead of rereading process.env", () => {
    const initialized = initializeExecutionProfile({ MCP_EXECUTION_PROFILE: "local-trusted-shell" });
    expect(initialized).toBe("local-trusted-shell");
    expect(getActiveExecutionProfile()).toBe("local-trusted-shell");
    expect(() => initializeExecutionProfile({ MCP_EXECUTION_PROFILE: "sandboxed-production" })).toThrow(
      /cannot change after initialization/,
    );
  });

  test("request context trusts runtime extra instead of tool arguments", () => {
    const controller = new AbortController();
    const context = createRequestContext(
      { requestId: 42, sessionId: "session-1", signal: controller.signal, authInfo: { subject: "host" } },
      "local-trusted-shell",
    );
    expect(context).toMatchObject({
      requestId: 42,
      sessionId: "session-1",
      scopeId: "session-1",
      profile: "local-trusted-shell",
      signal: controller.signal,
    });
  });

  test("capability policy allows local and denies undeclared sandbox capabilities", () => {
    const controller = new AbortController();
    const local = createCapabilityPolicy().check(
      createRequestContext({ requestId: 1, signal: controller.signal }, "local-trusted-shell"),
      "shell-execution",
    );
    expect(local).toEqual({ allowed: true });

    const sandboxContext = createRequestContext({ requestId: 2, signal: controller.signal }, "sandboxed-production");
    const policy = createCapabilityPolicy(["argv-execution"]);
    expect(policy.check(sandboxContext, "argv-execution")).toEqual({ allowed: true });
    expect(policy.check(sandboxContext, "shell-execution")).toMatchObject({
      allowed: false,
      code: "CAPABILITY_DENIED",
    });
  });

  test("capabilityGate returns null for local profile and CAPABILITY_DENIED for sandbox", () => {
    const controller = new AbortController();
    const localContext = createRequestContext({ requestId: 3, signal: controller.signal }, "local-trusted-shell");
    expect(capabilityGate(localContext, "host-process-inspection")).toBeNull();
    expect(capabilityGate(localContext, "host-environment-read")).toBeNull();

    const sandboxContext = createRequestContext({ requestId: 4, signal: controller.signal }, "sandboxed-production");
    const denial = capabilityGate(sandboxContext, "host-environment-read");
    expect(denial).not.toBeNull();
    expect(denial?.ok).toBe(false);
    if (!denial?.ok) {
      expect(denial.error.code).toBe(ErrorCode.CAPABILITY_DENIED);
      expect(denial.error.detail).toMatchObject({ capability: "host-environment-read" });
    }
  });

  test("parent and child accounts share ledger and cancellation", () => {
    const controller = new AbortController();
    const parent = new BudgetAccount("request", budgetLimits, controller.signal);
    const child = parent.child("child");
    expect(parent.reserve("output", 8)).toBe(true);
    expect(child.remaining("output")).toBe(2);
    expect(child.reserve("output", 3)).toBe(false);
    expect(child.reserve("queue", 2)).toBe(true);
    expect(parent.remaining("queue")).toBe(8);

    child.close();
    expect(parent.reserve("output", 1)).toBe(true);
    controller.abort();
    expect(parent.abortSignal.aborted).toBe(true);
    expect(child.abortSignal.aborted).toBe(true);
    expect(parent.reserve("output", 1)).toBe(false);
    parent.close();
    parent.close();
  });

  test("budget account rejects invalid reservations without corrupting the ledger", () => {
    const account = new BudgetAccount("request", budgetLimits);
    expect(account.reserve("output", -1)).toBe(false);
    expect(account.reserve("output", Infinity)).toBe(false);
    expect(account.reserve("output", 1.5)).toBe(false);
    expect(account.remaining("output")).toBe(10);
    account.close();
  });

  test("expired account exposes aborted signal and no remaining budget", () => {
    const account = new BudgetAccount("request", { ...budgetLimits, deadlineAt: Date.now() - 1 });
    expect(account.abortSignal.aborted).toBe(true);
    expect(account.remaining("output")).toBe(0);
    expect(account.reserve("output", 0)).toBe(false);
    account.close();
  });

  test("new error codes are additive and old strings remain stable", () => {
    expect(ErrorCode.PATH_FORBIDDEN).toBe("PATH_FORBIDDEN");
    expect(ErrorCode.SECRET_DETECTED).toBe("SECRET_DETECTED");
    expect(ErrorCode.RESOURCE_LIMIT).toBe("RESOURCE_LIMIT");
    expect(ErrorCode.CONFIG_INVALID).toBe("CONFIG_INVALID");
    expect(Errors.resourceLimit("budget").error.code).toBe(ErrorCode.RESOURCE_LIMIT);
    expect(Errors.cancelled().error.code).toBe(ErrorCode.CANCELLED);
    expect(Errors.capabilityDenied().error.code).toBe(ErrorCode.CAPABILITY_DENIED);
    expect(Errors.configInvalid("bad", "profile").error.code).toBe(ErrorCode.CONFIG_INVALID);
  });
});
