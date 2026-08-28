/**
 * partial-result 契约层 — SearchWarning 形状 / 搜索预算常量 / handler 层同源校验 helper
 * 唯一来源：搜索与列举工具的 complete/warnings/truncated 语义均以此处定义为准（design §3.1）
 */

import * as z from "zod";
import { Errors, type ToolError } from "./result.js";

/** 结构化降级事件：count 仅 PS_PARTIAL_WALK_ERRORS 使用（承载 PS 侧错误合计计数） */
export interface SearchWarning {
  code: string;
  path?: string;
  count?: number;
}

/** warnings 字段的 outputSchema 形状（与 SearchWarning 对应，count 可选不破坏 {code, path?} 基线） */
export const searchWarningSchema = z.object({
  code: z.string(),
  path: z.string().optional(),
  count: z.number().int().nonnegative().optional(),
});

export const WARNING_CODES = {
  EVERYTHING_EXEC_FAILED: "EVERYTHING_EXEC_FAILED",
  WALK_READ_FAILED: "WALK_READ_FAILED",
  GREP_FILE_READ_FAILED: "GREP_FILE_READ_FAILED",
  PS_PARTIAL_WALK_ERRORS: "PS_PARTIAL_WALK_ERRORS",
  GREP_PARTIAL_RESULTS: "GREP_PARTIAL_RESULTS",
  WARNINGS_TRUNCATED: "WARNINGS_TRUNCATED",
} as const;

/** 搜索/列举/进程预算：启动常量，不接环境变量（与 bounded-command-execution 先例一致） */
export const SEARCH_BUDGET = {
  searchFilesMaxResults: 500,
  everythingMaxResults: 1000,
  grepMaxResults: 500,
  maxDepth: 32,
  patternMaxChars: 512,
  patternMaxBytes: 2048,
  filePatternMaxChars: 256,
  processTopMax: 100,
  processFilterMaxChars: 128,
  maxWarnings: 50,
  maxMatchItemChars: 1000,
  warningPathMaxChars: 256,
} as const;

/** code point 口径截断（与 result.ts capErrorText 同源），超限尾部加省略号 */
function capCodePoints(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const points = Array.from(text);
  return points.length <= maxChars ? text : `${points.slice(0, maxChars).join("")}…`;
}

/**
 * 追加 warning：path 截断 256 code point；达到 maxWarnings 后以末尾一条
 * WARNINGS_TRUNCATED 收尾，后续 warning 不再追加
 */
export function pushWarning(list: SearchWarning[], warning: SearchWarning): void {
  if (list.length >= SEARCH_BUDGET.maxWarnings) {
    const last = list[list.length - 1];
    if (last?.code !== WARNING_CODES.WARNINGS_TRUNCATED) {
      list[list.length - 1] = { code: WARNING_CODES.WARNINGS_TRUNCATED };
    }
    return;
  }
  const entry: SearchWarning = { code: warning.code };
  if (warning.path !== undefined) entry.path = capCodePoints(warning.path, SEARCH_BUDGET.warningPathMaxChars);
  if (warning.count !== undefined) entry.count = warning.count;
  list.push(entry);
}

/**
 * handler 层同源校验（直调路径绕过 SDK zod 层时的第二道）：整数范围。
 * undefined 跳过（optional 字段，默认值由 handler 提供）；不通过返回 VALIDATION_ERROR。
 */
export function assertIntRange(
  value: number | undefined,
  opts: { min: number; max: number; param: string },
): ToolError | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < opts.min ||
    value > opts.max
  ) {
    return Errors.validationError(`${opts.param} must be an integer between ${opts.min} and ${opts.max}`, opts.param);
  }
  return null;
}

/**
 * handler 层同源校验：字符串 code point 数与 UTF-8 字节数双限（与 boundedString 同口径）。
 * undefined 跳过；不通过返回 VALIDATION_ERROR。
 */
export function assertStringBounded(
  value: string | undefined,
  opts: { maxChars: number; maxBytes: number; param: string },
): ToolError | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    return Errors.validationError(`${opts.param} must be a string`, opts.param);
  }
  if (Array.from(value).length > opts.maxChars) {
    return Errors.validationError(`${opts.param} exceeds ${opts.maxChars} character limit`, opts.param);
  }
  if (Buffer.byteLength(value, "utf8") > opts.maxBytes) {
    return Errors.validationError(`${opts.param} exceeds ${opts.maxBytes} byte limit`, opts.param);
  }
  return null;
}
