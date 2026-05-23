/**
 * 命令执行工具: execute_command, batch_execute, watch_command
 * 使用统一 ToolResult 协议 + MCP CallToolResult 兼容转换
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { adaptiveTimeout } from "../adaptive.js";
import { logger } from "../logger.js";
import { IS_WIN } from "../platform.js";
import { checkRateLimit, commandRateLimit } from "../ratelimit.js";
import { ErrorCode, fail, success, type ToolResult } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { hasDangerousPattern } from "../security.js";
import { session } from "../session.js";
import { spawnStream } from "../stream.js";
import { wrapHandler } from "../wrap.js";

export function registerCommandTools(server: McpServer) {
  // ====================================================================
  const ExecuteCommandInput = z.object({
    command: z.string().describe("The command to execute"),
    cwd: z.string().optional().describe("Working directory (optional)"),
    timeout: z.number().optional().describe("Timeout in ms, default 30000"),
  });
  type ExecuteCommandInput = z.infer<typeof ExecuteCommandInput>;

  server.registerTool(
    "execute_command",
    {
      title: "Execute Terminal Command",
      description: "Execute a single shell/terminal command. Returns structured result with exit code and stderr.",
      inputSchema: ExecuteCommandInput,
      outputSchema: z.object({
        stdout: z.string(),
        stderr: z.string(),
        exit_code: z.number(),
        timed_out: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    wrapHandler("execute_command", async ({ command, cwd, timeout }: ExecuteCommandInput) => {
      const t0 = Date.now();
      const dp = hasDangerousPattern(command);
      if (dp)
        return fail(ErrorCode.COMMAND_DANGEROUS, `Command blocked — dangerous pattern: ${dp}`, {
          retryable: false,
          param: "command",
          detail: { command, pattern: dp },
        });

      const rateErr = checkRateLimit(commandRateLimit, "execute_command");
      if (rateErr)
        return fail(ErrorCode.EXECUTION_FAILED, rateErr, { retryable: true, suggestion: "Wait 200ms and retry" });

      const block = await guardDestructiveAction("execute_command", `执行命令: ${command}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "command" });

      try {
        const shell = IS_WIN ? "cmd.exe" : "/bin/sh";
        const shellArgs = IS_WIN ? ["/c", "chcp 65001 >nul && " + command] : ["-c", command];
        const effectiveCwd = cwd || session.getCwd();
        const effectiveTimeout = timeout || adaptiveTimeout("execute_command");
        const result = await spawnStream(shell, shellArgs, { timeout: effectiveTimeout, cwd: effectiveCwd });
        session.pushHistory(command);

        if (result.timedOut)
          return fail(ErrorCode.TIMEOUT, "Command timed out", {
            retryable: true,
            param: "timeout",
            suggestion: "Use a simpler command or increase timeout",
          });

        const output = result.stdout || "(no output)";
        const errInfo = result.stderr ? `\n[stderr]:\n${result.stderr.slice(0, 500)}` : "";

        if (result.exitCode !== 0) {
          return fail(
            ErrorCode.EXECUTION_FAILED,
            `Command failed (exit ${result.exitCode})\n[stdout]:\n${output.slice(0, 500)}${errInfo}`,
            { retryable: true },
          );
        }
        const maxChars = 2000;
        const truncated = output.length > maxChars;
        return success(
          truncated ? output.slice(0, maxChars) + `\n... (truncated, ${output.length} chars total)` : output,
          {
            stdout: result.stdout,
            stderr: result.stderr,
            exit_code: result.exitCode ?? -1,
            timed_out: false,
          },
          { latency_ms: Date.now() - t0, truncated },
        );
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message || "Unknown error", { retryable: true });
      }
    }),
  );

  // ====================================================================
  const BatchExecuteInput = z.object({
    commands: z.array(z.string()).describe("Array of commands to execute"),
    cwd: z.string().optional().describe("Working directory"),
    stop_on_error: z.boolean().optional().describe("Stop if a command fails, default true"),
    parallel: z.boolean().optional().describe("Execute commands in parallel (no dependencies), default false"),
  });
  type BatchExecuteInput = z.infer<typeof BatchExecuteInput>;

  server.registerTool(
    "batch_execute",
    {
      title: "Batch Execute Commands",
      description: "Execute multiple commands sequentially. Stops on first error if stop_on_error is true (default).",
      inputSchema: BatchExecuteInput,
      outputSchema: z.object({
        results: z.array(
          z.object({
            command: z.string(),
            stdout: z.string(),
            stderr: z.string(),
            ok: z.boolean(),
            latency_ms: z.number(),
          }),
        ),
        summary: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("batch_execute", async ({ commands, cwd, stop_on_error, parallel }: BatchExecuteInput) => {
      const t0 = Date.now();
      const stop = stop_on_error !== false;
      const isParallel = parallel === true;

      for (const cmd of commands) {
        const dp = hasDangerousPattern(cmd);
        if (dp)
          return fail(ErrorCode.COMMAND_DANGEROUS, `Dangerous pattern in batch: ${dp}`, {
            retryable: false,
            param: "commands",
            detail: { command: cmd, pattern: dp },
          });
      }

      const block = await guardDestructiveAction("batch_execute", `批量执行 ${commands.length} 条命令`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "commands" });

      try {
        const results: Array<{ command: string; stdout: string; stderr: string; ok: boolean; latency_ms: number }> = [];
        let allOk = true;

        const execOne = async (cmd: string, idx: number) => {
          const ct0 = Date.now();
          try {
            logger.info("batch_execute", `step ${idx + 1}/${commands.length}`, cmd);
            const shell = IS_WIN ? "cmd.exe" : "/bin/sh";
            const shellArgs = IS_WIN ? ["/c", cmd] : ["-c", cmd];
            const r = await spawnStream(shell, shellArgs, { timeout: 30000, cwd: cwd || session.getCwd() });
            return {
              command: cmd,
              stdout: r.stdout || "",
              stderr: r.stderr || "",
              ok: r.exitCode === 0,
              latency_ms: Date.now() - ct0,
            };
          } catch (e: any) {
            return { command: cmd, stdout: "", stderr: e.message || "failed", ok: false, latency_ms: Date.now() - ct0 };
          }
        };

        if (isParallel) {
          // 并发限制为 4，避免同时 spawn 过多进程
          const concurrency = 4;
          const settled: typeof results = [];
          for (let i = 0; i < commands.length; i += concurrency) {
            const batch = commands.slice(i, i + concurrency);
            const batchResults = await Promise.all(batch.map((cmd: string, j: number) => execOne(cmd, i + j)));
            settled.push(...batchResults);
          }
          results.push(...settled);
          allOk = settled.every((r) => r.ok);
        } else {
          for (let i = 0; i < commands.length; i++) {
            const r = await execOne(commands[i], i);
            results.push(r);
            if (!r.ok) {
              allOk = false;
              if (stop) break;
            }
          }
        }

        session.pushHistory(commands.join("; "));
        const summary = allOk
          ? `All ${results.length} commands OK`
          : `${results.filter((r) => r.ok).length}/${results.length} commands OK`;
        return success(summary, { results, summary }, { latency_ms: Date.now() - t0 });
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message || "Batch failed", { retryable: true });
      }
    }),
  );

  // ====================================================================
  const WatchCommandInput = z.object({
    command: z.string().describe("The command to run"),
    duration: z.number().optional().describe("Max duration in ms, default 5000"),
    cwd: z.string().optional().describe("Working directory"),
  });
  type WatchCommandInput = z.infer<typeof WatchCommandInput>;

  server.registerTool(
    "watch_command",
    {
      title: "Watch Command Output",
      description: "Execute a command and capture output for a limited duration. Useful for real-time monitoring.",
      inputSchema: WatchCommandInput,
      outputSchema: z.object({ output: z.string(), captured_ms: z.number() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    wrapHandler("watch_command", async ({ command, duration, cwd }: WatchCommandInput) => {
      const t0 = Date.now();
      const dp = hasDangerousPattern(command);
      if (dp)
        return fail(ErrorCode.COMMAND_DANGEROUS, `Dangerous pattern: ${dp}`, {
          retryable: false,
          param: "command",
          detail: { command, pattern: dp },
        });

      const block = await guardDestructiveAction("watch_command", `监控命令: ${command}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "command" });

      try {
        const shell = IS_WIN ? "cmd.exe" : "/bin/sh";
        const shellArgs = IS_WIN ? ["/c", "chcp 65001 >nul && " + command] : ["-c", command];
        const result = await spawnStream(shell, shellArgs, { timeout: duration || 5000, cwd: cwd || session.getCwd() });
        const output = result.stdout || "(no output)";
        if (result.timedOut)
          return success(
            "$ " + command + "\n(timed out)\n" + output,
            { output, captured_ms: duration || 5000 },
            { latency_ms: Date.now() - t0 },
          );
        return success(
          "$ " + command + "\n" + output,
          { output, captured_ms: Date.now() - t0 },
          { latency_ms: Date.now() - t0 },
        );
      } catch (e: any) {
        return fail(ErrorCode.EXECUTION_FAILED, e.message || "Watch failed", { retryable: true });
      }
    }),
  );
}
