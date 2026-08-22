import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDeletePreview,
  deleteWithPreview,
  resetWorkspaceDeleteStateForTests,
} from "../../src/workspace-delete.js";

const TEST_ROOT = path.resolve(".etmcp/test-tmp/workspace-delete-unit");

afterEach(async () => {
  vi.restoreAllMocks();
  resetWorkspaceDeleteStateForTests();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("workspace-delete preview budgets", () => {
  test("returns VALIDATION_ERROR when the preview time budget is exhausted", async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true });
    const target = path.join(TEST_ROOT, "file.txt");
    await fs.writeFile(target, "budget", "utf8");

    // sweep（插入前清扫）与 deadline 各消耗一次 Date.now；之后恒返回 30_001 触发超预算
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(30_001);

    await expect(createDeletePreview(target, false)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      detail: { reason: "preview_budget_exceeded" },
    });
  });

  test("sweeps expired preview records when a new preview is created", async () => {
    await fs.mkdir(TEST_ROOT, { recursive: true });
    const target = path.join(TEST_ROOT, "file.txt");
    await fs.writeFile(target, "sweep", "utf8");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00Z"));
    const first = await createDeletePreview(target, false);

    // 推进 6 分钟（超过 5 分钟 TTL）后创建新 preview，应顺带清扫过期记录
    vi.setSystemTime(new Date("2026-08-23T00:06:00Z"));
    await createDeletePreview(target, false);
    vi.useRealTimers();

    // 记录已被清扫：错误消息是 "invalid, expired, used..."；若记录仍在则消息为 "has expired"
    await expect(deleteWithPreview(target, false, first.preview_id)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.not.stringContaining("has expired"),
    });
  });
});
