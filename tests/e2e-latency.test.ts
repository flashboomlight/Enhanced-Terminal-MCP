/**
 * 端到端延迟测试 — Enhanced Terminal MCP v3.1.0
 *
 * 通过 MCP SDK Client 以子进程方式连接 Server，
 * 真实调用每个工具并测量完整往返延迟（含协议序列化/反序列化、进程 IPC）。
 *
 * 延迟阈值（合理范围）：
 *   - 初始化连接：         < 3000ms
 *   - tools/list：         < 200ms
 *   - 纯内存/FS 元数据工具：< 500ms   (file_info, list_directory, read_file, write_file, make_directory, environment_vars)
 *   - 文件写入+清理：      < 500ms
 *   - Shell 命令执行：     < 3000ms   (execute_command, batch_execute, watch_command)
 *   - PowerShell/系统查询： < 12000ms   (get_system_info, process_list, network_info)
 *   - 搜索工具：           < 5000ms   (search_files, grep_content)
 *   - 归档工具：           < 5000ms   (compress_archive, extract_archive)
 *   - 安全拦截：           < 200ms    (dangerous command blocking)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// ===== 辅助：精确计时 =====
function timer() {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

// ===== 全局 MCP Client =====
let client: Client;
let transport: StdioClientTransport;

// 测试用临时目录
const TMP_DIR = path.join(os.tmpdir(), `mcp-latency-test-${Date.now()}`);
const TMP_FILE = path.join(TMP_DIR, "test-file.txt");
const TMP_ZIP = path.join(TMP_DIR, "test-archive.zip");
const TMP_EXTRACT = path.join(TMP_DIR, "extracted");

// ===== 延迟阈值 (ms) =====
const THRESHOLD = {
  INIT: 3000,
  LIST_TOOLS: 200,
  FAST_FS: 500,
  SHELL_CMD: 3000,
  SYSTEM: 12000,
  SEARCH: 5000,
  ARCHIVE: 5000,
  SECURITY: 200,
};

// ===== 收集所有延迟结果用于最终报告 =====
const latencyResults: Array<{ tool: string; latency: number; threshold: number; pass: boolean }> = [];

function record(tool: string, latency: number, threshold: number) {
  latencyResults.push({ tool, latency, threshold, pass: latency <= threshold });
}

// ===== Setup / Teardown =====
beforeAll(async () => {
  // 创建临时目录
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 启动 MCP Server 子进程并连接（off 模式以测试纯性能，不受安全锁影响）
  const elapsed = timer();
  transport = new StdioClientTransport({
    command: "node",
    args: [path.resolve("build/index.js")],
    cwd: process.cwd(),
    env: { ...process.env, MCP_SAFETY_MODE: "off" },
  });
  client = new Client({ name: "latency-test", version: "1.0.0" });
  await client.connect(transport);
  const ms = elapsed();
  record("initialize (connect)", ms, THRESHOLD.INIT);
  console.log(`  ⏱ initialize: ${ms}ms (threshold: ${THRESHOLD.INIT}ms)`);
}, 10000);

afterAll(async () => {
  // 打印延迟报告
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║            端到端延迟测试报告 (E2E Latency Report)            ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║ 工具                        │ 延迟     │ 阈值     │ 状态  ║");
  console.log("╠═════════════════════════════╪══════════╪══════════╪═══════╣");
  for (const r of latencyResults) {
    const name = r.tool.padEnd(27);
    const lat = `${r.latency}ms`.padStart(8);
    const thr = `${r.threshold}ms`.padStart(8);
    const status = r.pass ? " PASS " : " FAIL ";
    console.log(`║ ${name}│ ${lat} │ ${thr} │${status}║`);
  }
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const failures = latencyResults.filter((r) => !r.pass);
  if (failures.length > 0) {
    console.log(`\n⚠ ${failures.length} tool(s) exceeded latency threshold.`);
  } else {
    console.log(`\n✅ All ${latencyResults.length} measurements within threshold.`);
  }

  // 清理
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ═══════════════════════════════════════════════════
// 1. 协议层延迟
// ═══════════════════════════════════════════════════
describe("Protocol Layer Latency", () => {
  test("tools/list should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.listTools();
    const ms = elapsed();
    record("tools/list", ms, THRESHOLD.LIST_TOOLS);
    console.log(`    ⏱ tools/list: ${ms}ms — found ${result.tools.length} tools`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.LIST_TOOLS);
    expect(result.tools.length).toBe(27);
  });

  test("prompts/list should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.listPrompts();
    const ms = elapsed();
    record("prompts/list", ms, THRESHOLD.LIST_TOOLS);
    console.log(`    ⏱ prompts/list: ${ms}ms — found ${result.prompts.length} prompts`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.LIST_TOOLS);
    expect(result.prompts.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════
// 2. 文件操作工具延迟
// ═══════════════════════════════════════════════════
describe("File Operations Latency", () => {
  test("make_directory should respond within threshold", async () => {
    const subDir = path.join(TMP_DIR, "sub-dir");
    const elapsed = timer();
    const result = await client.callTool({ name: "make_directory", arguments: { dir_path: subDir } });
    const ms = elapsed();
    record("make_directory", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ make_directory: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });

  test("write_file should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "write_file",
      arguments: { file_path: TMP_FILE, content: "Hello from latency test!\nLine 2\nLine 3\n" },
    });
    const ms = elapsed();
    record("write_file", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ write_file: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });

  test("read_file should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "read_file",
      arguments: { file_path: TMP_FILE },
    });
    const ms = elapsed();
    record("read_file", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ read_file: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0]?.text;
    expect(text).toContain("Hello from latency test!");
  });

  test("file_info should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "file_info",
      arguments: { target_path: TMP_FILE },
    });
    const ms = elapsed();
    record("file_info", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ file_info: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });

  test("list_directory should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "list_directory",
      arguments: { dir_path: TMP_DIR },
    });
    const ms = elapsed();
    record("list_directory", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ list_directory: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });

  test("copy_move (copy) should respond within threshold", async () => {
    const dest = path.join(TMP_DIR, "copied.txt");
    const elapsed = timer();
    const result = await client.callTool({
      name: "copy_move",
      arguments: { source: TMP_FILE, destination: dest, operation: "copy" },
    });
    const ms = elapsed();
    record("copy_move (copy)", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ copy_move (copy): ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });

  test("delete_path should respond within threshold", async () => {
    const target = path.join(TMP_DIR, "copied.txt");
    const elapsed = timer();
    const result = await client.callTool({
      name: "delete_path",
      arguments: { target_path: target },
    });
    const ms = elapsed();
    record("delete_path", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ delete_path: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════
// 3. 命令执行工具延迟
// ═══════════════════════════════════════════════════
describe("Command Execution Latency", () => {
  test("execute_command (echo) should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "execute_command",
      arguments: { command: "echo hello-latency-test" },
    });
    const ms = elapsed();
    record("execute_command (echo)", ms, THRESHOLD.SHELL_CMD);
    console.log(`    ⏱ execute_command: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SHELL_CMD);
    expect(result.isError).toBeFalsy();
    const text = (result.content as any)[0]?.text;
    expect(text).toContain("hello-latency-test");
  });

  test("batch_execute (2 echoes) should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "batch_execute",
      arguments: { commands: ["echo batch-1", "echo batch-2"] },
    });
    const ms = elapsed();
    record("batch_execute (2 cmds)", ms, THRESHOLD.SHELL_CMD);
    console.log(`    ⏱ batch_execute: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SHELL_CMD);
    expect(result.isError).toBeFalsy();
  });

  test("watch_command (short) should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "watch_command",
      arguments: { command: "echo watch-test", duration: 1000 },
    });
    const ms = elapsed();
    record("watch_command", ms, THRESHOLD.SHELL_CMD);
    console.log(`    ⏱ watch_command: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SHELL_CMD);
    expect(result.isError).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════
// 4. 安全拦截延迟
// ═══════════════════════════════════════════════════
describe("Security Blocking Latency", () => {
  test("dangerous command should be blocked near-instantly", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "execute_command",
      arguments: { command: "rm -rf / --no-preserve-root" },
    });
    const ms = elapsed();
    record("security block", ms, THRESHOLD.SECURITY);
    console.log(`    ⏱ security block: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SECURITY);
    expect(result.isError).toBeTruthy();
    const text = (result.content as any)[0]?.text;
    expect(text).toContain("blocked");
  });

  test("path traversal should be blocked near-instantly", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "read_file",
      arguments: { file_path: "../../etc/passwd" },
    });
    const ms = elapsed();
    record("path traversal block", ms, THRESHOLD.SECURITY);
    console.log(`    ⏱ path traversal block: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SECURITY);
    expect(result.isError).toBeTruthy();
    const text = (result.content as any)[0]?.text;
    expect(text).toContain("traversal");
  });

  test("system directory protection should block near-instantly", async () => {
    const forbidden = os.platform() === "win32" ? "C:\\Windows\\test.txt" : "/etc/test.txt";
    const elapsed = timer();
    const result = await client.callTool({
      name: "write_file",
      arguments: { file_path: forbidden, content: "should not write" },
    });
    const ms = elapsed();
    record("forbidden path block", ms, THRESHOLD.SECURITY);
    console.log(`    ⏱ forbidden path block: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SECURITY);
    expect(result.isError).toBeTruthy();
    const text = (result.content as any)[0]?.text;
    expect(text).toContain("blocked");
  });
});

// ═══════════════════════════════════════════════════
// 5. 搜索工具延迟
// ═══════════════════════════════════════════════════
describe("Search Tools Latency", () => {
  test("search_files should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "search_files",
      arguments: { dir_path: TMP_DIR, pattern: "*.txt", max_results: 10 },
    });
    const ms = elapsed();
    record("search_files", ms, THRESHOLD.SEARCH);
    console.log(`    ⏱ search_files: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SEARCH);
    expect(result.isError).toBeFalsy();
  });

  test("grep_content should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "grep_content",
      arguments: { dir_path: TMP_DIR, pattern: "Hello", file_pattern: "*.txt", max_results: 10 },
    });
    const ms = elapsed();
    record("grep_content", ms, THRESHOLD.SEARCH);
    console.log(`    ⏱ grep_content: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SEARCH);
    expect(result.isError).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════
// 6. 系统信息工具延迟
// ═══════════════════════════════════════════════════
describe("System Tools Latency", () => {
  test("environment_vars (get) should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "environment_vars",
      arguments: { action: "get", name: "PATH" },
    });
    const ms = elapsed();
    record("environment_vars (get)", ms, THRESHOLD.FAST_FS);
    console.log(`    ⏱ environment_vars: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.FAST_FS);
    expect(result.isError).toBeFalsy();
  });

  test("process_list should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "process_list",
      arguments: { top: 5 },
    });
    const ms = elapsed();
    record("process_list", ms, THRESHOLD.SYSTEM);
    console.log(`    ⏱ process_list: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SYSTEM);
    expect(result.isError).toBeFalsy();
  });

  test("network_info (config) should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "network_info",
      arguments: { action: "config" },
    });
    const ms = elapsed();
    record("network_info", ms, THRESHOLD.SYSTEM);
    console.log(`    ⏱ network_info: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SYSTEM);
    expect(result.isError).toBeFalsy();
  });

  test("get_system_info should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "get_system_info",
      arguments: {},
    });
    const ms = elapsed();
    record("get_system_info", ms, THRESHOLD.SYSTEM);
    console.log(`    ⏱ get_system_info: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.SYSTEM);
    expect(result.isError).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════
// 7. 归档工具延迟
// ═══════════════════════════════════════════════════
describe("Archive Tools Latency", () => {
  test("compress_archive should respond within threshold", async () => {
    const elapsed = timer();
    const result = await client.callTool({
      name: "compress_archive",
      arguments: { source_path: TMP_FILE, output_path: TMP_ZIP },
    });
    const ms = elapsed();
    record("compress_archive", ms, THRESHOLD.ARCHIVE);
    console.log(`    ⏱ compress_archive: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.ARCHIVE);
    expect(result.isError).toBeFalsy();
  });

  test("extract_archive should respond within threshold", async () => {
    // 只有前一个 compress 成功才能测试
    if (!fs.existsSync(TMP_ZIP)) {
      console.log("    ⏭ skipped (no archive)");
      return;
    }
    const elapsed = timer();
    const result = await client.callTool({
      name: "extract_archive",
      arguments: { archive_path: TMP_ZIP, output_dir: TMP_EXTRACT },
    });
    const ms = elapsed();
    record("extract_archive", ms, THRESHOLD.ARCHIVE);
    console.log(`    ⏱ extract_archive: ${ms}ms`);

    expect(ms).toBeLessThanOrEqual(THRESHOLD.ARCHIVE);
    expect(result.isError).toBeFalsy();
  });
});
