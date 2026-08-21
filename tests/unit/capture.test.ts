/**
 * capture.ts 单元测试
 */
import { describe, expect, test } from "vitest";
import { captureCommand } from "../../src/capture.js";

describe("captureCommand", () => {
  test("captures stdout raw bytes and exit code", async () => {
    const chunks: Buffer[] = [];
    const r = await captureCommand("node", ["-e", "console.log('hello')"], {
      onChunk: (_s, c) => {
        chunks.push(c);
      },
    });
    expect(r.error).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdoutActualBytes).toBe(6);
    expect(Buffer.concat(chunks).toString()).toBe("hello\n");
  });

  test("captures stderr separately", async () => {
    const r = await captureCommand("node", ["-e", "console.error('err')"]);
    expect(r.stderrActualBytes).toBe(4);
    expect(r.stdoutActualBytes).toBe(0);
    expect(r.exitCode).toBe(0);
  });

  test("preserves non-zero exit code", async () => {
    const r = await captureCommand("node", ["-e", "process.exit(3)"]);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  test("timeout terminates the process and sets timedOut", async () => {
    const r = await captureCommand("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeout: 100 });
    expect(r.timedOut).toBe(true);
  });

  test("drains large output while counting actual bytes without retaining", async () => {
    const size = 512 * 1024;
    let chunks = 0;
    const r = await captureCommand("node", ["-e", `process.stdout.write('x'.repeat(${size}))`], {
      onChunk: () => {
        chunks++;
      },
    });
    expect(r.error).toBeNull();
    expect(r.exitCode).toBe(0);
    expect(r.stdoutActualBytes).toBe(size);
    expect(chunks).toBeGreaterThan(0);
  });

  test("chunk order is preserved", async () => {
    const parts: string[] = [];
    await captureCommand("node", ["-e", "for (let i=0;i<100;i++) console.log(i)"], {
      onChunk: (_s, c) => {
        parts.push(c.toString());
      },
    });
    const expected = Array.from({ length: 100 }, (_, i) => `${i}\n`).join("");
    expect(parts.join("")).toBe(expected);
  });

  test("backpressure false pauses the stream until consumer resumes", async () => {
    const size = 256 * 1024;
    let received = 0;
    let pauses = 0;
    const r = await captureCommand("node", ["-e", `process.stdout.write('y'.repeat(${size}))`], {
      onChunk: (_s, c, controls) => {
        received += c.length;
        pauses++;
        setTimeout(() => controls.resume("stdout"), 0);
        return false;
      },
    });
    expect(r.error).toBeNull();
    expect(received).toBe(size);
    expect(r.stdoutActualBytes).toBe(size);
    expect(pauses).toBeGreaterThan(0);
  });

  test("sync resume inside async callback prevents double resume", async () => {
    const size = 64 * 1024;
    let received = 0;
    const r = await captureCommand("node", ["-e", `process.stdout.write('z'.repeat(${size}))`], {
      onChunk: async (_s, c, controls) => {
        received += c.length;
        controls.resume("stdout");
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });
    expect(r.error).toBeNull();
    expect(received).toBe(size);
    expect(r.exitCode).toBe(0);
  });

  test("async consumer keeps chunk order", async () => {
    const parts: string[] = [];
    await captureCommand("node", ["-e", "for (let i=0;i<50;i++) console.log('line'+i)"], {
      onChunk: async (_s, c) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        parts.push(c.toString());
      },
    });
    const expected = Array.from({ length: 50 }, (_, i) => `line${i}\n`).join("");
    expect(parts.join("")).toBe(expected);
  });

  test("spawn failure resolves with error instead of throwing", async () => {
    const r = await captureCommand("nonexistent_command_xyz", []);
    expect(r.error).not.toBeNull();
    expect(r.exitCode).toBeNull();
  });

  test("consumer throw is fail-closed: child terminated, error surfaced", async () => {
    const r = await captureCommand("node", ["-e", "console.log('x'); setTimeout(()=>{}, 10000)"], {
      onChunk: () => {
        throw new Error("sink-fail");
      },
    });
    expect(r.error?.message).toBe("sink-fail");
    expect(r.exitCode).toBeNull();
  });

  test("consumer async reject is fail-closed", async () => {
    const r = await captureCommand("node", ["-e", "console.log('x'); setTimeout(()=>{}, 10000)"], {
      onChunk: async () => {
        throw new Error("async-sink-fail");
      },
    });
    expect(r.error?.message).toBe("async-sink-fail");
  });
});
