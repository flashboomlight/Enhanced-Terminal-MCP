/**
 * Handler wrapper unit tests
 */
import { describe, expect, it } from "vitest";
import type { createRequestContext } from "../../src/profile.js";
import { success, type ToolResult } from "../../src/result.js";
import { wrapHandler } from "../../src/wrap.js";

describe("wrapHandler", () => {
  it("wraps handler and returns CallToolResult", async () => {
    const handler = async (args: { name: string }): Promise<ToolResult> => {
      return success(`Hello ${args.name}`, { greeting: `Hello ${args.name}` });
    };
    const wrapped = wrapHandler("test_wrap", handler);

    const result = await wrapped({ name: "World" });
    expect(result.content).toBeDefined();
    const textContent = result.content[0];
    expect("text" in textContent).toBe(true);
    if ("text" in textContent) {
      expect(textContent.text).toContain("Hello World");
    }
  });

  it("passes runtime request context to the handler", async () => {
    const controller = new AbortController();
    let received: ReturnType<typeof createRequestContext> | undefined;
    const handler = async (_args: { profile?: string }, context: ReturnType<typeof createRequestContext>) => {
      received = context;
      return success("context-ok", { profile: context.profile, request_id: context.requestId });
    };
    const wrapped = wrapHandler("context_wrap", handler);

    await wrapped(
      { profile: "spoofed-by-arguments" },
      { requestId: 99, sessionId: "runtime-session", signal: controller.signal },
    );

    expect(received).toMatchObject({
      requestId: 99,
      sessionId: "runtime-session",
      scopeId: "runtime-session",
      profile: "local-trusted-shell",
      signal: controller.signal,
    });
  });

  it("caches idempotent read tools", async () => {
    // Note: test_wrap is not in CACHEABLE_TOOLS, so this just tests pass-through
    let callCount = 0;
    const handler = async (): Promise<ToolResult> => {
      callCount++;
      return success("result", { ok: true });
    };
    const wrapped = wrapHandler("read_file", handler); // read_file IS cacheable

    const r1 = await wrapped({ file_path: "/test/cache.txt" } as any);
    const r2 = await wrapped({ file_path: "/test/cache.txt" } as any);
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    // Cache hit means handler only called once
    expect(callCount).toBe(1);
  });

  it("does not cache failed results", async () => {
    const { fail, ErrorCode } = await import("../../src/result.js");
    let callCount = 0;
    const handler = async (): Promise<ToolResult> => {
      callCount++;
      return fail(ErrorCode.EXECUTION_FAILED, "test error", { retryable: true });
    };
    const wrapped = wrapHandler("read_file", handler);

    await wrapped({ file_path: "/test/fail.txt" } as any);
    await wrapped({ file_path: "/test/fail.txt" } as any);
    expect(callCount).toBe(2); // not cached
  });

  it("does not cache partial results (structured.complete === false)", async () => {
    let callCount = 0;
    const handler = async (): Promise<ToolResult> => {
      callCount++;
      return success("partial", { complete: false, matches: [] });
    };
    const wrapped = wrapHandler("read_file", handler);

    await wrapped({ file_path: "/test/partial-f.txt" } as any);
    await wrapped({ file_path: "/test/partial-f.txt" } as any);
    expect(callCount).toBe(2); // partial 结果不进共享缓存
  });

  it("caches successful results when structured.complete is true", async () => {
    let callCount = 0;
    const handler = async (): Promise<ToolResult> => {
      callCount++;
      return success("full", { complete: true, matches: ["a"] });
    };
    const wrapped = wrapHandler("read_file", handler);

    await wrapped({ file_path: "/test/partial-t.txt" } as any);
    await wrapped({ file_path: "/test/partial-t.txt" } as any);
    expect(callCount).toBe(1);
  });
});
