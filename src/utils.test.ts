/**
 * utils.ts 单元测试
 */
import { describe, expect, test } from "vitest";
import { formatSize } from "./utils.js";

// ====================================================================
// formatSize
// ====================================================================
describe("formatSize", () => {
  test("0 字节", () => {
    expect(formatSize(0)).toBe("0.00 B");
  });

  test("小于 1KB", () => {
    expect(formatSize(500)).toBe("500.00 B");
    expect(formatSize(1023)).toBe("1023.00 B");
  });

  test("KB 范围", () => {
    expect(formatSize(1024)).toBe("1.00 KB");
    expect(formatSize(1536)).toBe("1.50 KB");
    expect(formatSize(1048575)).toBe("1024.00 KB");
  });

  test("MB 范围", () => {
    expect(formatSize(1048576)).toBe("1.00 MB");
    expect(formatSize(104857600)).toBe("100.00 MB");
  });

  test("GB 范围", () => {
    expect(formatSize(1073741824)).toBe("1.00 GB");
    expect(formatSize(5368709120)).toBe("5.00 GB");
  });

  test("TB 范围", () => {
    expect(formatSize(1099511627776)).toBe("1.00 TB");
  });

  test("负数也正常格式化", () => {
    expect(formatSize(-1024)).toBe("-1.00 KB");
  });
});
