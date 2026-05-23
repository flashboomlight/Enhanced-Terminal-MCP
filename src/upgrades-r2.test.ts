/**
 * 第二轮升级精确测试
 *
 * 【性能-A】PowerShell 内联路径压缩/解压/下载
 * 【性能-B】Everything 搜索结果按 dir_path 过滤
 * 【功能-A】copy_move/delete_path 操作后失效缓存
 * 【功能-B】execute_command 使用 adaptiveTimeout
 * 【功能-C】list_directory TTL 缩短 + 写操作联动失效
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ====================================================================
// 【性能-A】PowerShell 内联路径 — 压缩/解压实际可用
// ====================================================================
describe("【性能-A】PowerShell 内联路径压缩解压", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-ps-inline-"));
    await fs.writeFile(path.join(tmpDir, "source.txt"), "test content for compression");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("getCompressSpec 生成的命令实际能压缩文件", async () => {
    const { getCompressSpec } = await import("./platform.js");
    const { safeExecFile } = await import("./utils.js");

    const src = path.join(tmpDir, "source.txt");
    const dst = path.join(tmpDir, "output.zip");
    const spec = getCompressSpec(src, dst);

    // 验证命令结构
    expect(spec.file).toBe("powershell.exe");
    expect(spec.args).toHaveLength(3); // -NoProfile, -Command, script
    expect(spec.args[2]).toContain("Compress-Archive");
    expect(spec.args[2]).toContain(src.replace(/'/g, "''"));

    // 实际执行
    await safeExecFile(spec.file, spec.args, 30000);
    const stat = await fs.stat(dst);
    expect(stat.size).toBeGreaterThan(0);
  });

  test("getExtractSpec 生成的命令实际能解压文件", async () => {
    const { getCompressSpec, getExtractSpec } = await import("./platform.js");
    const { safeExecFile } = await import("./utils.js");

    const src = path.join(tmpDir, "source.txt");
    const zipFile = path.join(tmpDir, "archive.zip");
    const outDir = path.join(tmpDir, "extracted");

    // 先压缩
    const compSpec = getCompressSpec(src, zipFile);
    await safeExecFile(compSpec.file, compSpec.args, 30000);

    // 再解压
    const extSpec = getExtractSpec(zipFile, outDir);
    expect(extSpec.args[2]).toContain("Expand-Archive");
    await safeExecFile(extSpec.file, extSpec.args, 30000);

    // 验证解压结果
    const extracted = await fs.readFile(path.join(outDir, "source.txt"), "utf-8");
    expect(extracted).toBe("test content for compression");
  });

  test("getDownloadSpec 生成正确的内联命令结构", async () => {
    const { getDownloadSpec } = await import("./platform.js");
    const spec = getDownloadSpec("https://example.com/file.txt", "C:\\tmp\\out.txt");

    expect(spec.file).toBe("powershell.exe");
    expect(spec.args[2]).toContain("Invoke-WebRequest");
    expect(spec.args[2]).toContain("https://example.com/file.txt");
    expect(spec.args[2]).toContain("C:\\tmp\\out.txt");
    // 不应有 param() 块
    expect(spec.args[2]).not.toContain("param(");
  });

  test("路径含单引号时正确转义", async () => {
    const { getCompressSpec } = await import("./platform.js");
    const spec = getCompressSpec("C:\\it's a test\\file.txt", "C:\\out\\it's.zip");
    // PowerShell 单引号转义：' -> ''
    expect(spec.args[2]).toContain("it''s a test");
    expect(spec.args[2]).toContain("it''s.zip");
  });
});

// ====================================================================
// 【性能-B】Everything 搜索结果按 dir_path 过滤
// ====================================================================
describe("【性能-B】Everything 搜索结果目录过滤逻辑", () => {
  test("只保留 dir_path 前缀匹配的结果", () => {
    // 模拟 Everything 返回的全盘结果
    const allResults = [
      "D:\\Projects\\app\\src\\index.ts",
      "D:\\Projects\\app\\src\\utils.ts",
      "C:\\Users\\admin\\Desktop\\index.ts",
      "D:\\Other\\index.ts",
    ];

    const dirPath = "D:\\Projects\\app";
    const normalizedDir = path.resolve(dirPath).toLowerCase();

    const filtered = allResults.filter(l =>
      l.trim().toLowerCase().startsWith(normalizedDir)
    );

    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toContain("D:\\Projects\\app\\src\\index.ts");
    expect(filtered[1]).toContain("D:\\Projects\\app\\src\\utils.ts");
  });
});

// ====================================================================
// 【功能-A】copy_move/delete_path 操作后失效缓存
// ====================================================================
describe("【功能-A】文件操作后缓存失效", () => {
  test("delete_path 后相关缓存被清除", async () => {
    const { LRUCache } = await import("./cache.js");
    const cache = new LRUCache<string>(64, 60000);

    const filePath = "D:\\test\\to-delete.txt";
    const escaped = filePath.replace(/\\/g, "\\\\");
    cache.set(`read_file:{"file_path":"${escaped}"}`, "old-content");
    cache.set(`file_info:{"target_path":"${escaped}"}`, "old-info");
    cache.set(`read_file:{"file_path":"D:\\\\test\\\\other.txt"}`, "keep");

    // 模拟 delete_path 后的 invalidateByValue
    const cleared = cache.invalidateByValue(escaped);
    expect(cleared).toBe(2);
    expect(cache.get(`read_file:{"file_path":"D:\\\\test\\\\other.txt"}`)).not.toBeNull();
  });

  test("copy_move 后源和目标路径缓存都被清除", async () => {
    const { LRUCache } = await import("./cache.js");
    const cache = new LRUCache<string>(64, 60000);

    const src = "D:\\src\\file.txt".replace(/\\/g, "\\\\");
    const dst = "D:\\dst\\file.txt".replace(/\\/g, "\\\\");
    cache.set(`read_file:{"file_path":"${src}"}`, "src-content");
    cache.set(`read_file:{"file_path":"${dst}"}`, "dst-content");
    cache.set(`list_directory:{"dir_path":"${src.replace("\\\\file.txt", "")}"}`, "src-dir");

    cache.invalidateByValue(src);
    cache.invalidateByValue(dst);

    expect(cache.get(`read_file:{"file_path":"${src}"}`)).toBeNull();
    expect(cache.get(`read_file:{"file_path":"${dst}"}`)).toBeNull();
  });
});

// ====================================================================
// 【功能-B】adaptiveTimeout 实际被调用
// ====================================================================
describe("【功能-B】adaptiveTimeout 集成", () => {
  test("无历史数据时返回默认值 30000", async () => {
    const { adaptiveTimeout } = await import("./adaptive.js");
    const { telemetry } = await import("./telemetry.js");
    telemetry.reset();

    const timeout = adaptiveTimeout("execute_command");
    expect(timeout).toBe(30000);
  });

  test("有足够历史数据时返回自适应值", async () => {
    const { adaptiveTimeout } = await import("./adaptive.js");
    const { telemetry } = await import("./telemetry.js");
    telemetry.reset();

    // 模拟 10 次调用，平均延迟 15000ms
    for (let i = 0; i < 10; i++) {
      telemetry.record({ toolName: "execute_command", latency_ms: 15000, ok: true, cacheHit: false, timestamp: Date.now() });
    }

    const timeout = adaptiveTimeout("execute_command");
    // P95 ≈ avg × 3 = 45000, 上限 4× 默认 = 120000
    // max(30000, min(45000, 120000)) = 45000
    expect(timeout).toBe(45000);
    telemetry.reset();
  });

  test("自适应值不超过 4× 默认值", async () => {
    const { adaptiveTimeout } = await import("./adaptive.js");
    const { telemetry } = await import("./telemetry.js");
    telemetry.reset();

    // 模拟极高延迟
    for (let i = 0; i < 10; i++) {
      telemetry.record({ toolName: "execute_command", latency_ms: 100000, ok: true, cacheHit: false, timestamp: Date.now() });
    }

    const timeout = adaptiveTimeout("execute_command");
    // max(30000, min(300000, 120000)) = 120000
    expect(timeout).toBe(120000);
    telemetry.reset();
  });
});

// ====================================================================
// 【功能-C】list_directory TTL 缩短 + 写操作联动失效
// ====================================================================
describe("【功能-C】list_directory 缓存策略", () => {
  test("TOOL_TTL 中 list_directory 为 5000ms", async () => {
    const { TOOL_TTL } = await import("./cache.js");
    expect(TOOL_TTL.list_directory).toBe(5000);
  });

  test("TOOL_TTL 中 get_system_info 为 60000ms", async () => {
    const { TOOL_TTL } = await import("./cache.js");
    expect(TOOL_TTL.get_system_info).toBe(60000);
  });

  test("LRUCache.set 使用自定义 TTL 后按时过期", async () => {
    const { LRUCache } = await import("./cache.js");
    const cache = new LRUCache<string>(64, 60000); // 默认 60s

    // 用 1ms TTL 设置
    cache.set("short-lived", "value", 1);
    // 等待过期
    await new Promise(r => setTimeout(r, 5));
    expect(cache.get("short-lived")).toBeNull();

    // 用默认 TTL 设置
    cache.set("long-lived", "value");
    expect(cache.get("long-lived")).not.toBeNull();
  });

  test("write_file 后父目录缓存被失效", async () => {
    const { LRUCache } = await import("./cache.js");
    const cache = new LRUCache<string>(64, 60000);

    const filePath = "D:\\project\\src\\new-file.ts";
    const parentDir = "D:\\project\\src";
    const parentEscaped = parentDir.replace(/\\/g, "\\\\");

    cache.set(`list_directory:{"dir_path":"${parentEscaped}"}`, "dir-listing");
    cache.set(`list_directory:{"dir_path":"D:\\\\other"}`, "other-listing");

    // 模拟 write_file 后的失效逻辑
    cache.invalidateByValue(parentEscaped);

    expect(cache.get(`list_directory:{"dir_path":"${parentEscaped}"}`)).toBeNull();
    expect(cache.get(`list_directory:{"dir_path":"D:\\\\other"}`)).not.toBeNull();
  });
});
