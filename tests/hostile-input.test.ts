import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MCP_TEST_ROOT, resultErrorCode, resultText, startMcpServer } from "./support/mcp-server.js";

interface HostileCase {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  kind: "protocol" | "tool";
  code?: string;
}

const TEST_ROOT = path.join(MCP_TEST_ROOT, "hostile");
const WORK_ROOT = path.join(TEST_ROOT, "work");
const SENTINEL = path.join(WORK_ROOT, "sentinel.txt");

/** 递归展开 corpus 中的动态测试占位符。 */
function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => materialize(item));
  if (!value || typeof value !== "object") {
    if (value === "{{OVER_100_COMMANDS}}") {
      return Array.from({ length: 101 }, (_, index) => `echo hostile-${index}`);
    }
    if (value === "{{OVER_512_CHARS}}") return "x".repeat(513);
    if (typeof value === "string") return value.replaceAll("{{WORK}}", WORK_ROOT);
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, materialize(nested)]),
  );
}

/** 读取版本化 hostile-input corpus，避免把一组规则散落在测试代码中。 */
async function loadCorpus(): Promise<HostileCase[]> {
  const file = new URL("./fixtures/mcp-hostile-input-corpus.json", import.meta.url);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as HostileCase[];
  return raw.map((item) => ({ ...item, arguments: materialize(item.arguments) as Record<string, unknown> }));
}

beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(WORK_ROOT, { recursive: true });
  await fs.writeFile(SENTINEL, "keep-this-file", "utf8");
});

afterAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("hostile input corpus", () => {
  test("rejects bounded and policy-invalid inputs without side effects", async () => {
    const connection = await startMcpServer({}, {}, TEST_ROOT);
    const corpus = await loadCorpus();
    try {
      expect(corpus.length).toBeGreaterThanOrEqual(20);
      for (const item of corpus) {
        const result = await connection.client.callTool({ name: item.tool, arguments: item.arguments });
        expect(result.isError, item.id).toBe(true);
        if (item.kind === "protocol") {
          expect(resultErrorCode(result), item.id).toBeUndefined();
          expect(resultText(result), item.id).toContain("Input validation error");
        } else {
          expect(resultErrorCode(result), item.id).toBe(item.code);
        }
      }
    } finally {
      await connection.close();
    }

    await expect(fs.readFile(SENTINEL, "utf8")).resolves.toBe("keep-this-file");
    await expect(fs.access(path.join(WORK_ROOT, "download.bin"))).rejects.toThrow();
    await expect(fs.access(path.join(WORK_ROOT, "copy.txt"))).rejects.toThrow();
    await expect(fs.access(path.join(WORK_ROOT, "extract"))).rejects.toThrow();
  });
});
