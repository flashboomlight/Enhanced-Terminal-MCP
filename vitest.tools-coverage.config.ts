/**
 * 工具层专属覆盖率门禁
 *
 * src/tools/** 的 handler 主体靠子进程 e2e（V8 收集不到子进程覆盖率），
 * 因此被主配置（vitest.config.ts）排除在全局阈值外。本配置单独度量工具层，
 * 以显式底线防止回归；运行：pnpm run test:coverage:tools
 *
 * 底线依据（2026-08-28 实测）：files/manage/utility/search 的纯逻辑单测 +
 * 27 个新增补盲用例后 statements≈60 / branches≈50 / functions≈64 / lines≈63，
 * 底线略低于现状留出正常波动空间。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/tools/**/*.test.ts"],
    testTimeout: 30000,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/tools/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text-summary"],
      thresholds: {
        lines: 55,
        functions: 60,
        branches: 45,
        statements: 55,
      },
    },
  },
});
