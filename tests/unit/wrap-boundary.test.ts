/**
 * wrapHandler 边界行为单元测试（REL-05 + 响应字节兜底）
 *
 * 未预期异常 → INTERNAL_ERROR（message 经 redactor）、取消逃逸 → CANCELLED、
 * 错误不入缓存、(args, extra) 适配固化、MCP_RESPONSE_MAX_BYTES 超限 → RESOURCE_LIMIT。
 * 响应上限为进程级惰性单例，因此超限用例通过 vi.resetModules + 动态 import 隔离。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { success } from "../../src/result.js";
import { telemetry } from "../../src/telemetry.js";
import { wrapHandler } from "../../src/wrap.js";

/** GitHub token 形态样例（仅测试用，36 位字母数字） */
const FAKE_TOKEN = `ghp_${"A1".repeat(18)}`;

describe("wrapHandler boundary", () => {
  afterEach(() => {
    vi.resetModules();
  });

  test("unexpected throw maps to INTERNAL_ERROR with redacted message", async () => {
    const h = wrapHandler("boundary_tool", async () => {
      throw new Error(`boom ${FAKE_TOKEN}`);
    });
    const res = await h({});
    expect(res.isError).toBe(true);
    const err = res.structuredContent as { error: { code: string; message: string } };
    expect(err.error.code).toBe("INTERNAL_ERROR");
    expect(res.content[0].type).toBe("text");
    expect(String(res.content[0].text)).toContain("[INTERNAL_ERROR]");
    expect(String(res.content[0].text)).not.toContain(FAKE_TOKEN);
    expect(err.error.message).not.toContain(FAKE_TOKEN);
  });

  test("aborted signal maps throw to CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = wrapHandler("boundary_tool", async () => {
      throw new Error("late failure after cancellation");
    });
    const res = await h({}, { requestId: "req-1", signal: controller.signal });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("CANCELLED");
  });

  test("AbortError thrown without aborted signal also maps to CANCELLED", async () => {
    const h = wrapHandler("boundary_tool", async () => {
      const e = new Error("aborted internally");
      e.name = "AbortError";
      throw e;
    });
    const res = await h({}, { requestId: "req-2", signal: new AbortController().signal });
    expect((res.structuredContent as { error: { code: string } }).error.code).toBe("CANCELLED");
  });

  test("thrown errors are not cached for cacheable tools", async () => {
    let calls = 0;
    const h = wrapHandler("list_directory", async () => {
      calls++;
      throw new Error("nope");
    });
    const first = await h({ dir_path: "somewhere" });
    const second = await h({ dir_path: "somewhere" });
    expect(calls).toBe(2);
    expect(first.isError).toBe(true);
    expect(second.isError).toBe(true);
  });

  test("handler context comes from extra, not from caller-forged arguments", async () => {
    const h = wrapHandler("boundary_tool", async (_args: Record<string, unknown>, context) =>
      success("ok", { requestId: context.requestId, scopeId: context.scopeId }),
    );
    const res = await h({ requestId: "forged" }, { requestId: "real-req", signal: new AbortController().signal });
    const structured = res.structuredContent as { requestId: unknown };
    expect(structured.requestId).toBe("real-req");
  });

  test("boundary failures still land in telemetry", async () => {
    const before = telemetry.summary().total_calls;
    const h = wrapHandler("boundary_tool", async () => {
      throw new Error("telemetry probe");
    });
    await h({});
    expect(telemetry.summary().total_calls).toBe(before + 1);
  });

  test("oversized response becomes RESOURCE_LIMIT; invalid config falls back to default", async () => {
    vi.resetModules();
    process.env.MCP_RESPONSE_MAX_BYTES = "10";
    try {
      const { wrapHandler: fresh } = await import("../../src/wrap.js");
      const h = fresh("boundary_tool", async () => success("x".repeat(100), { v: "y".repeat(50) }));
      const res = await h({});
      expect(res.isError).toBe(true);
      const err = (res.structuredContent as { error: { code: string; detail?: { limit?: number } } }).error;
      expect(err.code).toBe("RESOURCE_LIMIT");
      expect(err.detail?.limit).toBe(10);
    } finally {
      delete process.env.MCP_RESPONSE_MAX_BYTES;
    }

    vi.resetModules();
    process.env.MCP_RESPONSE_MAX_BYTES = "not-a-number";
    try {
      const { wrapHandler: fresh2 } = await import("../../src/wrap.js");
      const h2 = fresh2("boundary_tool", async () => success("ok", { a: 1 }));
      const res2 = await h2({});
      expect(res2.isError).toBeFalsy();
    } finally {
      delete process.env.MCP_RESPONSE_MAX_BYTES;
      vi.resetModules();
    }
  });
});
