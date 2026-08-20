import { afterEach, describe, expect, test } from "vitest";
import {
  getSecretsScanTier,
  scanContent,
  shouldBlockSecretReads,
  shouldScanOnCache,
  shouldScanOnWrite,
} from "../../src/scan.js";

describe("secrets scan tiers", () => {
  const prev = process.env.MCP_SECRETS_SCAN;
  afterEach(() => {
    if (prev === undefined) delete process.env.MCP_SECRETS_SCAN;
    else process.env.MCP_SECRETS_SCAN = prev;
  });

  const sampleKey = "key=sk-abcdefghijklmnopqrstuvwxyz012345";

  test("default cache tier scans and detects", () => {
    delete process.env.MCP_SECRETS_SCAN;
    expect(getSecretsScanTier()).toBe("cache");
    expect(shouldScanOnWrite()).toBe(true);
    expect(shouldScanOnCache()).toBe(true);
    expect(shouldBlockSecretReads()).toBe(false);
    expect(scanContent(sampleKey).safe).toBe(false);
  });

  test("off tier never finds secrets", () => {
    process.env.MCP_SECRETS_SCAN = "off";
    expect(shouldScanOnWrite()).toBe(false);
    expect(shouldScanOnCache()).toBe(false);
    expect(scanContent(sampleKey).safe).toBe(true);
  });

  test("write tier scans content but not for cache policy", () => {
    process.env.MCP_SECRETS_SCAN = "write";
    expect(shouldScanOnWrite()).toBe(true);
    expect(shouldScanOnCache()).toBe(false);
    expect(shouldBlockSecretReads()).toBe(false);
  });

  test("strict enables read block flag", () => {
    process.env.MCP_SECRETS_SCAN = "strict";
    expect(shouldScanOnCache()).toBe(true);
    expect(shouldBlockSecretReads()).toBe(true);
    expect(scanContent(sampleKey).safe).toBe(false);
  });
});
