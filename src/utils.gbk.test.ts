/**
 * utils.ts GBK fallback 路径测试
 * 覆盖 smartDecode 中 GBK TextDecoder 抛出异常时的 catch 分支 (line 80)
 */
import { describe, test, expect, vi } from "vitest";

describe("smartDecode GBK fallback (TextDecoder stub)", () => {
  test("safeExec catches GBK decode failure gracefully", async () => {
    vi.resetModules();

    // 在导入 utils 之前 stub TextDecoder
    vi.stubGlobal("TextDecoder", class MockTextDecoder {
      encoding: string;
      constructor(enc: string, _opts?: any) {
        this.encoding = enc;
      }
      decode(_buf: Buffer): string {
        if (this.encoding === "utf-8" || this.encoding === "utf8") {
          return "\ufffd"; // 触发 GBK 回退
        }
        // GBK 抛出异常 → 触发 .catch
        throw new Error("mock GBK TextDecoder failure");
      }
    });

    vi.doMock("child_process", () => ({
      exec: (_cmd: string, _opts: any, cb: Function) => {
        setImmediate(() => cb(null, Buffer.from("test"), Buffer.from("")));
        return { on: vi.fn() };
      },
      execFile: vi.fn(),
    }));
    vi.doMock("./platform.js", () => ({
      getShell: () => "cmd.exe",
      wrapCommand: (cmd: string) => cmd,
      IS_WIN: true,
    }));

    const { safeExec } = await import("./utils.js");
    const result = await safeExec("test-cmd", 5000);

    // UTF-8 回退应返回 \ufffd
    expect(result.stdout).toBe("\ufffd");
  });
});
