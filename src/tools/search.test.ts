/**
 * search.ts 可测试逻辑单元测试
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { globToRegex, registerSearchTools } from "../tools/search.js";

describe("search tools pure logic", () => {
  test("globToRegex matches wildcard patterns", () => {
    const re = globToRegex("*.ts");
    expect(re.test("file.ts")).toBe(true);
    expect(re.test("file.js")).toBe(false);
  });

  test("globToRegex matches single char wildcard", () => {
    const re = globToRegex("test?.txt");
    expect(re.test("test1.txt")).toBe(true);
    expect(re.test("test12.txt")).toBe(false);
  });

  test("globToRegex escapes regex metacharacters", () => {
    const re = globToRegex("file[1].txt");
    expect(re.test("file[1].txt")).toBe(true);
    expect(re.test("file1.txt")).toBe(false);
  });

  test("grep_content returns multiple matching lines up to max_results", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-grep-test-"));
    try {
      await fs.writeFile(path.join(tmpDir, "matches.txt"), "needle one\nskip\nneedle two\nneedle three\n", "utf-8");
      const tools = new Map<string, { handler: (args: Record<string, unknown>) => Promise<any> }>();
      const server = {
        registerTool(name: string, _spec: unknown, handler: (args: Record<string, unknown>) => Promise<any>) {
          tools.set(name, { handler });
        },
      };
      registerSearchTools(server as any);

      const result = await tools.get("grep_content")?.handler({
        dir_path: tmpDir,
        pattern: "needle",
        file_pattern: "*.txt",
        max_results: 2,
      });

      expect(result?.isError).toBeFalsy();
      expect(result?.structuredContent.matches).toHaveLength(2);
      expect(result?.structuredContent.matches[0]).toContain("needle one");
      expect(result?.structuredContent.matches[1]).toContain("needle two");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
