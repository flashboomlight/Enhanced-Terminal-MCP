import { beforeEach, describe, expect, test } from "vitest";
import { ES_EXE_PATH, ES_EXE_SHA256, ensureEsExeIntegrity, resetEsIntegrityCache } from "./es-integrity.js";

describe("es-integrity", () => {
  beforeEach(() => {
    resetEsIntegrityCache();
  });

  test("locked hash is 64 hex chars", () => {
    expect(ES_EXE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("path points at es_tool/es.exe", () => {
    expect(ES_EXE_PATH.replace(/\\/g, "/")).toMatch(/es_tool\/es\.exe$/);
  });

  test("ensureEsExeIntegrity accepts packaged binary when present", async () => {
    const path = await ensureEsExeIntegrity();
    // Windows CI/dev has the binary; other platforms may not package it
    if (path) {
      expect(path).toBe(ES_EXE_PATH);
      // second call hits cache
      expect(await ensureEsExeIntegrity()).toBe(path);
    } else {
      expect(path).toBeNull();
    }
  });
});
