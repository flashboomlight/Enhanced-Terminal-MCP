import { defineConfig } from "vitest/config";

const coverageRun = process.argv.some((arg) => arg === "--coverage" || arg.startsWith("--coverage."));
const IS_WIN = process.platform === "win32";

// 主覆盖率阈值按平台标定（issue 2026-08-29-linux-gate-parity）：
// win32-only 分支（shell 解析、PowerShell spec、Everything 路径）在非 Windows 不执行，
// Linux 结构性低 ~1%；两侧各自守住 floor，Windows 契约不动。
const thresholds = IS_WIN
  ? { lines: 80, functions: 80, branches: 70, statements: 80 }
  : { lines: 81, functions: 81, branches: 70, statements: 78 };

export default defineConfig({
  test: {
    ...(coverageRun ? { exclude: ["tests/e2e-latency.test.ts"] } : {}),
    testTimeout: 30000,
    hookTimeout: 15000,
    sequence: {
      concurrent: false,
    },
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/tools/**",
        "src/**/*.test.ts",
        "tests/**",
        // Tool handlers are exercised by subprocess E2E; V8 cannot collect child-process coverage.
        // The tools layer has its own thresholded coverage run: pnpm run test:coverage:tools
        // (vitest.tools-coverage.config.ts) so the blind spot stays measured and floor-guarded.
      ],
      reporter: ["text", "text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds,
    },
  },
});
