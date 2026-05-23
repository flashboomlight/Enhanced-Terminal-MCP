import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 15000,
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/**/*.test.ts",
        "src/**/*.unit.test.ts",
        "src/tools/**",              // 工具处理器由 e2e 测试覆盖（子进程，无法收集覆盖率）
      ],
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        // 单平台覆盖率上限 — platform.ts 的 Unix/Win 互斥分支不可同时覆盖
        // 在当前平台 (Windows) 上，以下为最高可达成值
        lines: 89.8,
        functions: 90,
        branches: 79.5,
        statements: 90,
      },
    },
  },
});
