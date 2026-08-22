import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getHeadlessPolicySummary,
  HEADLESS_CONFIG_ERROR,
  initHeadlessPolicy,
  resetHeadlessPolicyForTests,
  validateHeadlessDeleteTarget,
} from "../../src/headless-policy.js";

const TEST_PARENT = path.resolve(".etmcp/test-tmp/headless-policy");
const ROOT = path.join(TEST_PARENT, "root");
const OUTSIDE = path.join(TEST_PARENT, "outside.txt");

let previousConfirmationMode: string | undefined;
let previousAllowedRoots: string | undefined;

beforeEach(async () => {
  previousConfirmationMode = process.env.MCP_CONFIRMATION_MODE;
  previousAllowedRoots = process.env.MCP_ALLOWED_ROOTS;
  await fs.rm(TEST_PARENT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  resetHeadlessPolicyForTests();
});

afterEach(async () => {
  if (previousConfirmationMode === undefined) delete process.env.MCP_CONFIRMATION_MODE;
  else process.env.MCP_CONFIRMATION_MODE = previousConfirmationMode;
  if (previousAllowedRoots === undefined) delete process.env.MCP_ALLOWED_ROOTS;
  else process.env.MCP_ALLOWED_ROOTS = previousAllowedRoots;
  resetHeadlessPolicyForTests();
  await fs.rm(TEST_PARENT, { recursive: true, force: true });
});

describe("headless policy", () => {
  test("requires a valid absolute root and exposes workspace-delete summary", async () => {
    process.env.MCP_CONFIRMATION_MODE = "headless";
    process.env.MCP_ALLOWED_ROOTS = ROOT;

    await initHeadlessPolicy();

    expect(getHeadlessPolicySummary()).toEqual({
      configured: true,
      rootCount: 1,
      surface: "workspace-delete",
    });
  });

  test("rejects missing roots before serving headless requests", async () => {
    process.env.MCP_CONFIRMATION_MODE = "headless";
    delete process.env.MCP_ALLOWED_ROOTS;

    await expect(initHeadlessPolicy()).rejects.toMatchObject({ code: HEADLESS_CONFIG_ERROR });
  });

  test("only allows strict descendants, never the root itself", async () => {
    process.env.MCP_CONFIRMATION_MODE = "headless";
    process.env.MCP_ALLOWED_ROOTS = ROOT;
    const child = path.join(ROOT, "child.txt");
    await fs.writeFile(child, "child", "utf8");
    await fs.writeFile(OUTSIDE, "outside", "utf8");
    await initHeadlessPolicy();

    expect(await validateHeadlessDeleteTarget(child)).toBeNull();
    expect(await validateHeadlessDeleteTarget(ROOT)).toContain("strict descendant");
    expect(await validateHeadlessDeleteTarget(OUTSIDE)).toContain("strict descendant");
  });

  test("rejects reparse roots and targets when the Windows filesystem permits junction creation", async () => {
    const linkedRoot = path.join(TEST_PARENT, "linked-root");
    try {
      await fs.symlink(ROOT, linkedRoot, "junction");
    } catch {
      return;
    }

    process.env.MCP_CONFIRMATION_MODE = "headless";
    process.env.MCP_ALLOWED_ROOTS = linkedRoot;
    await expect(initHeadlessPolicy()).rejects.toMatchObject({ code: HEADLESS_CONFIG_ERROR });

    resetHeadlessPolicyForTests();
    process.env.MCP_ALLOWED_ROOTS = ROOT;
    await initHeadlessPolicy();
    const linkedTarget = path.join(ROOT, "linked-target");
    await fs.symlink(TEST_PARENT, linkedTarget, "junction");
    expect(await validateHeadlessDeleteTarget(linkedTarget)).toContain("reparse point");
  });

  test("does not enable headless policy for normal confirmation mode", async () => {
    process.env.MCP_CONFIRMATION_MODE = "normal-invalid-for-this-setting";
    process.env.MCP_ALLOWED_ROOTS = ROOT;

    await initHeadlessPolicy();

    expect(getHeadlessPolicySummary()).toEqual({
      configured: false,
      rootCount: 0,
      surface: "none",
    });
  });
});
