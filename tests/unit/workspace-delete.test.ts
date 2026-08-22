import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeletePreview, resetWorkspaceDeleteStateForTests } from "../../src/workspace-delete.js";

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

    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(30_001);

    await expect(createDeletePreview(target, false)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      detail: { reason: "preview_budget_exceeded" },
    });
  });
});
