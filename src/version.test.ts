/**
 * version.ts 单元测试
 */

import * as fs from "node:fs/promises";
import { describe, expect, test } from "vitest";

import { VERSION } from "./version.js";

describe("version", () => {
  test("VERSION 读取 package.json 版本号", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("VERSION 与磁盘 package.json 一致", async () => {
    const pkg = JSON.parse(await fs.readFile("package.json", "utf-8"));
    expect(VERSION).toBe(pkg.version);
  });
});
