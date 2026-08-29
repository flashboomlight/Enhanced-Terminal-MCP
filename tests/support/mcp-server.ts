import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const MCP_TEST_ROOT = path.resolve(".etmcp/test-tmp/mcp-gates");
const SERVER_ENTRY = path.resolve("build/index.js");

export interface StartedMcpServer {
  client: Client;
  transport: StdioClientTransport;
  stateDir: string;
  close(): Promise<void>;
}

export interface ExitedMcpServer {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** 等待指定毫秒；测试中的短暂让步不依赖阻塞式 shell sleep。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 提取 MCP 文本 content，供 conformance/hostile 断言使用。 */
export function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

/** 提取统一 structured error code；协议层异常不伪造为工具错误。 */
export function resultErrorCode(result: { structuredContent?: unknown }): string | undefined {
  const structured = result.structuredContent;
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  const error = (structured as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** 启动一个隔离 state root 的真实 stdio MCP client/server。 */
export async function startMcpServer(
  overrides: Record<string, string> = {},
  clientOptions: ConstructorParameters<typeof Client>[1] = {},
  testRoot = MCP_TEST_ROOT,
): Promise<StartedMcpServer> {
  await fs.mkdir(testRoot, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(testRoot, "state-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...process.env,
      MCP_SAFETY_MODE: "off",
      MCP_AUDIT_MODE: "off",
      MCP_EXECUTION_PROFILE: "local-trusted-shell",
      ENHANCED_TERMINAL_DISABLE_FILE_INFO: "0",
      MCP_STATE_DIR: stateDir,
      ...overrides,
    },
  });
  const client = new Client({ name: "enhanced-terminal-mcp-gate", version: "1.0.0" }, clientOptions);
  let closed = false;
  try {
    await client.connect(transport);
  } catch (error) {
    await fs.rm(stateDir, { recursive: true, force: true });
    throw error;
  }
  return {
    client,
    transport,
    stateDir,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  };
}

/** 启动 server 直到退出；用于验证 startup fail-closed/fatal 语义。 */
export async function runServerUntilExit(
  overrides: Record<string, string>,
  timeoutMs = 5000,
  testRoot = MCP_TEST_ROOT,
): Promise<ExitedMcpServer> {
  await fs.mkdir(testRoot, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(testRoot, "exit-state-"));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_AUDIT_MODE: "off",
      MCP_STATE_DIR: stateDir,
      ...overrides,
    },
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  try {
    return await waitForExit(child, timeoutMs);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

/** 等待 child 退出并限制测试自身的等待时间。 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ExitedMcpServer> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程可能已在退出事件与超时回调之间结束。
      }
      reject(new Error(`MCP server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}
