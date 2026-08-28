/**
 * ProcessIdentityProvider 的输入、解析和 identity 不变量测试。
 *
 * 终止副作用通过 fake provider 验证，绝不调用真实 kill/taskkill。
 */
import { describe, expect, test } from "vitest";
import {
  defaultProcessIdentityProvider,
  isExactProcessNameValid,
  isProcessIdentityValid,
  normalizeProcessName,
  parseKillTarget,
  parseProcStat,
  parsePsIdentityOutput,
  parseWindowsIdentityOutput,
  sameProcessIdentity,
} from "../../src/process-identity.js";
import { ErrorCode } from "../../src/result.js";

function errorCode(value: ReturnType<typeof parseKillTarget>): string | undefined {
  return value.ok ? undefined : value.error.code;
}

describe("process identity input and parsers", () => {
  test("kill target requires exactly one verified target", () => {
    expect(errorCode(parseKillTarget({}))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(errorCode(parseKillTarget({ pid: 1234, name: "worker" }))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(parseKillTarget({ pid: 1234, force: true })).toEqual({ pid: 1234, force: true });
    expect(parseKillTarget({ name: "worker.exe" })).toEqual({ exactName: "worker.exe", force: false });
  });

  test("kill target rejects unsafe PID and process names", () => {
    for (const pid of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 0, 2_147_483_648]) {
      expect(errorCode(parseKillTarget({ pid }))).toBe(ErrorCode.VALIDATION_ERROR);
    }
    for (const name of ["", " worker", "worker*", "worker?", "C:\\worker.exe", "worker\u0000"]) {
      const actual = name === "worker\u0000" ? `worker${String.fromCharCode(0)}` : name;
      expect(errorCode(parseKillTarget({ name: actual }))).toBe(ErrorCode.VALIDATION_ERROR);
    }
    expect(errorCode(parseKillTarget({ name: "x".repeat(129) }))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(errorCode(parseKillTarget({ pid: 1234, force: "yes" }))).toBe(ErrorCode.VALIDATION_ERROR);
    expect(errorCode(parseKillTarget({ pid: 1234, force: null }))).toBe(ErrorCode.VALIDATION_ERROR);
  });

  test("name validation does not sanitize invalid input into another target", () => {
    expect(isExactProcessNameValid("worker.exe")).toBe(true);
    expect(isExactProcessNameValid("worker*")).toBe(false);
    expect(isExactProcessNameValid(`worker${String.fromCharCode(31)}`)).toBe(false);
    expect(normalizeProcessName("worker.exe", true)).toBe("worker");
    expect(normalizeProcessName("worker.exe", false)).toBe("worker.exe");
  });

  test("Windows JSON identity parser requires PID, name and start proof", () => {
    const identities = parseWindowsIdentityOutput(
      '[{"pid":1234,"name":"worker","startedAt":"2026-08-28T01:02:03.0000000Z"}]',
    );
    expect(identities[0]).toMatchObject({ pid: 1234, name: "worker", token: expect.stringContaining("windows:") });
    expect(() => parseWindowsIdentityOutput("not-json")).toThrow();
    expect(() => parseWindowsIdentityOutput('[{"pid":1234,"name":"worker"}]')).toThrow();
  });

  test("Linux proc stat parser preserves comm and extracts group/start token", () => {
    const fields = ["S", "1", "123", ...new Array(16).fill("0"), "12345", "0"];
    const parsed = parseProcStat(`123 (worker)child) ${fields.join(" ")}`);
    expect(parsed).toEqual({
      pid: 123,
      name: "worker)child",
      state: "S",
      processGroupId: 123,
      startTicks: 12345,
    });
  });

  test("macOS ps parser extracts a re-checkable start token and group", () => {
    const identities = parsePsIdentityOutput("1234 worker Tue Aug 26 10:20:30 2026 1234\n");
    expect(identities[0]).toMatchObject({ pid: 1234, name: "worker", processGroupId: 1234 });
    expect(identities[0]?.token).toContain("macos:");
  });

  test("identity comparison rejects PID reuse", () => {
    const first = {
      pid: 1234,
      name: "worker",
      startedAt: 100,
      token: "linux:100",
      ownedByCurrentWorker: false,
    };
    expect(sameProcessIdentity(first, { ...first })).toBe(true);
    expect(sameProcessIdentity(first, { ...first, token: "linux:101", startedAt: 101 })).toBe(false);
  });

  test("default provider inspects the current process and a missing PID safely", async () => {
    const current = await defaultProcessIdentityProvider.inspectPid(process.pid);
    expect(current.ok).not.toBe(false);
    if (!current.ok) return;
    expect(current.pid).toBe(process.pid);
    expect(isProcessIdentityValid(current)).toBe(true);

    const missing = await defaultProcessIdentityProvider.inspectPid(2_147_483_647);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});
