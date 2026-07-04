/**
 * search.ts 可测试逻辑单元测试
 */

import { describe, expect, test } from "vitest";
import { globToRegex } from "../tools/search.js";

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
});
