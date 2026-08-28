/**
 * partial-result.ts 契约层单元测试
 */

import { describe, expect, test } from "vitest";
import {
  assertIntRange,
  assertStringBounded,
  pushWarning,
  SEARCH_BUDGET,
  type SearchWarning,
  WARNING_CODES,
} from "../../src/partial-result.js";

describe("pushWarning", () => {
  test("appends warnings with code/path/count", () => {
    const list: SearchWarning[] = [];
    pushWarning(list, { code: WARNING_CODES.WALK_READ_FAILED, path: "/some/dir" });
    pushWarning(list, { code: WARNING_CODES.PS_PARTIAL_WALK_ERRORS, count: 3 });
    expect(list).toEqual([
      { code: "WALK_READ_FAILED", path: "/some/dir" },
      { code: "PS_PARTIAL_WALK_ERRORS", count: 3 },
    ]);
  });

  test("truncates path at 256 code points with ellipsis", () => {
    const list: SearchWarning[] = [];
    pushWarning(list, { code: WARNING_CODES.WALK_READ_FAILED, path: "x".repeat(300) });
    expect(list[0].path).toHaveLength(SEARCH_BUDGET.warningPathMaxChars + 1);
    expect(list[0].path?.endsWith("…")).toBe(true);
  });

  test("caps at maxWarnings and marks WARNINGS_TRUNCATED at the tail", () => {
    const list: SearchWarning[] = [];
    for (let i = 0; i < SEARCH_BUDGET.maxWarnings + 5; i++) {
      pushWarning(list, { code: WARNING_CODES.WALK_READ_FAILED, path: `/d/${i}` });
    }
    expect(list).toHaveLength(SEARCH_BUDGET.maxWarnings);
    expect(list[SEARCH_BUDGET.maxWarnings - 1]).toEqual({ code: WARNING_CODES.WARNINGS_TRUNCATED });
  });
});

describe("assertIntRange", () => {
  const opts = { min: 1, max: 100, param: "max_results" };

  test("undefined passes (optional field)", () => {
    expect(assertIntRange(undefined, opts)).toBeNull();
  });

  test("boundary values pass", () => {
    expect(assertIntRange(1, opts)).toBeNull();
    expect(assertIntRange(100, opts)).toBeNull();
  });

  test.each([0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s", (value) => {
    const err = assertIntRange(value, opts);
    expect(err?.ok).toBe(false);
    expect(err?.error.code).toBe("VALIDATION_ERROR");
    expect(err?.error.param).toBe("max_results");
  });
});

describe("assertStringBounded", () => {
  const opts = { maxChars: 4, maxBytes: 8, param: "pattern" };

  test("undefined passes", () => {
    expect(assertStringBounded(undefined, opts)).toBeNull();
  });

  test("within limits passes", () => {
    expect(assertStringBounded("abcd", opts)).toBeNull();
  });

  test("rejects over char limit (code point 口径)", () => {
    const err = assertStringBounded("abcde", opts);
    expect(err?.error.code).toBe("VALIDATION_ERROR");
    expect(err?.error.message).toContain("character");
  });

  test("counts emoji as one code point but multi-byte UTF-8", () => {
    // 3 个 emoji = 3 code points ≤ 4，但 UTF-8 12 bytes > 8 → byte 限拒绝
    const err = assertStringBounded("😀😀😀", opts);
    expect(err?.error.code).toBe("VALIDATION_ERROR");
    expect(err?.error.message).toContain("byte");
    // 2 个 emoji = 2 code points、8 bytes → 通过
    expect(assertStringBounded("😀😀", opts)).toBeNull();
  });
});
