/**
 * archive.ts 工具行为单元测试（fake server 直调 handler）
 *
 * 只覆盖错误映射路径；真实压缩/解压的端到端行为由
 * tests/unit/infra.test.ts 的 getCompressSpec/getExtractSpec 实测与 e2e 覆盖。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "vitest";
import { initSafeGuard } from "../../../src/safeguard.js";
import { resetStateDirCache } from "../../../src/state-dir.js";
import { registerArchiveTools } from "../../../src/tools/archive.js";

const TMP_BASE = fileURLToPath(new URL("../../../.etmcp/test-tmp/", import.meta.url));

type ToolHandler = (args: Record<string, unknown>) => Promise<any>;

function registerTools() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool(name: string, _spec: unknown, handler: ToolHandler) {
      tools.set(name, { handler });
    },
  };
  registerArchiveTools(server as any);
  return tools;
}

describe("archive tools error mapping (unit)", () => {
  let workDir = "";

  beforeEach(async () => {
    await fs.mkdir(TMP_BASE, { recursive: true });
    workDir = await fs.mkdtemp(path.join(TMP_BASE, "archive-"));
    process.env.MCP_SAFETY_MODE = "off";
    process.env.MCP_STATE_DIR = path.join(workDir, "state");
    resetStateDirCache();
    initSafeGuard();
  });

  test("compress_archive reports a structured error for a missing source", async () => {
    const tools = registerTools();
    const result = await tools.get("compress_archive")?.handler({
      source_path: path.join(workDir, "missing.txt"),
      output_path: path.join(workDir, "out.zip"),
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "ARCHIVE_FAILED" });
  });

  test("compress_archive rejects oversized source before spawning", async () => {
    const original = process.env.MCP_ARCHIVE_MAX_INPUT_BYTES;
    process.env.MCP_ARCHIVE_MAX_INPUT_BYTES = "10";
    try {
      const bigSource = path.join(workDir, "big.bin");
      await fs.writeFile(bigSource, Buffer.alloc(100, 0x61));
      const tools = registerTools();
      const result = await tools.get("compress_archive")?.handler({
        source_path: bigSource,
        output_path: path.join(workDir, "out.zip"),
      });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent.error).toMatchObject({ code: "RESOURCE_LIMIT" });
      await expect(fs.access(path.join(workDir, "out.zip"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (original === undefined) delete process.env.MCP_ARCHIVE_MAX_INPUT_BYTES;
      else process.env.MCP_ARCHIVE_MAX_INPUT_BYTES = original;
    }
  });

  test("extract_archive reports a structured error for a missing archive", async () => {
    const tools = registerTools();
    const result = await tools.get("extract_archive")?.handler({
      archive_path: path.join(workDir, "missing.zip"),
      output_dir: path.join(workDir, "out"),
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent.error).toMatchObject({ code: "ARCHIVE_FAILED" });
  });
});
