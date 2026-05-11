import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30000,   // 单个测试最多 30 秒（给 get_system_info 等系统查询充足时间）
    hookTimeout: 15000,   // beforeAll/afterAll 最多 15 秒
    sequence: {
      concurrent: false,  // 顺序执行，保证端到端测试不互相干扰
    },
  },
});
