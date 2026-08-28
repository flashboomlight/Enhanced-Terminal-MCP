/**
 * native-search.ts 遍历层单元测试
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { nativeGrepContent, nativeSearchFiles } from "../../src/native-search.js";

const TMP_BASE = fileURLToPath(new URL("../../.etmcp/test-tmp/", import.meta.url));

describe("native-search", () => {
  let workDir: string;

  beforeEach(async () => {
    await fs.mkdir(TMP_BASE, { recursive: true });
    workDir = await fs.mkdtemp(path.join(TMP_BASE, "native-search-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  test("walks tree and reports complete=true when fully covered", async () => {
    await fs.writeFile(path.join(workDir, "a.ts"), "x", "utf-8");
    await fs.mkdir(path.join(workDir, "sub"));
    await fs.writeFile(path.join(workDir, "sub", "b.ts"), "x", "utf-8");

    const outcome = await nativeSearchFiles(workDir, /\.ts$/i, { maxResults: 50, maxDepth: 5 });
    expect(outcome.complete).toBe(true);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.matches).toHaveLength(2);
  });

  test("root being a file yields WALK_READ_FAILED and complete=false", async () => {
    const fileRoot = path.join(workDir, "not-a-dir.txt");
    await fs.writeFile(fileRoot, "x", "utf-8");

    const outcome = await nativeSearchFiles(fileRoot, /\.ts$/i, { maxResults: 50, maxDepth: 5 });
    expect(outcome.complete).toBe(false);
    expect(outcome.warnings[0]?.code).toBe("WALK_READ_FAILED");
    expect(outcome.matches).toEqual([]);
  });

  test("skips hidden directories", async () => {
    await fs.mkdir(path.join(workDir, ".hidden"));
    await fs.writeFile(path.join(workDir, ".hidden", "secret.ts"), "x", "utf-8");

    const outcome = await nativeSearchFiles(workDir, /\.ts$/i, { maxResults: 50, maxDepth: 5 });
    expect(outcome.matches).toEqual([]);
    expect(outcome.complete).toBe(true);
  });

  test("aborts with AbortError when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      nativeSearchFiles(workDir, /\.ts$/i, { maxResults: 50, maxDepth: 5, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("grep truncates long match lines with marker", async () => {
    const longLine = "A".repeat(1500);
    await fs.writeFile(path.join(workDir, "long.txt"), `${longLine}\nshort\n`, "utf-8");

    const outcome = await nativeGrepContent(workDir, /\.txt$/i, /A+/, { maxResults: 50 });
    expect(outcome.matches).toHaveLength(1);
    expect(outcome.matches[0].endsWith("…[truncated]")).toBe(true);
  });

  test("grep finds matches and keeps complete=true", async () => {
    await fs.writeFile(path.join(workDir, "m.txt"), "needle one\nskip\nneedle two\n", "utf-8");

    const outcome = await nativeGrepContent(workDir, /\.txt$/i, /needle/gi, { maxResults: 50 });
    expect(outcome.complete).toBe(true);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.matches).toHaveLength(2);
    expect(outcome.matches[0]).toContain("needle one");
  });
});
