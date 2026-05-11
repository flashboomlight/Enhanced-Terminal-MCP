// src/tools/command.ts — 命令执行工具：execute_command / batch_execute / watch_command
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeExec, ok, fail } from "../utils.js";
import { hasDangerousPattern } from "../security.js";
import { guardDestructiveAction, getSafetyMode } from "../safeguard.js";
import { logger } from "../logger.js";

export function registerCommandTools(server: McpServer) {

  // ===== Tool 1: execute_command =====
  server.registerTool(
    "execute_command",
    {
      title: "Execute Command",
      description: "Execute a terminal/shell command and return the output",
      inputSchema: {
        command: z.string().describe("The command to execute"),
        cwd: z.string().optional().describe("Working directory (optional)"),
        timeout: z.number().optional().describe("Timeout in ms, default 30000"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, timeout }) => {
      logger.info("execute_command", "exec", command);

      // 硬性底线：危险命令直接拒绝（所有模式生效，不可绕过）
      if (hasDangerousPattern(command)) {
        logger.warn("execute_command", "blocked", `Dangerous pattern: ${command}`);
        return fail("Command blocked: contains potentially dangerous pattern. Please review and try a safer command.");
      }

      // strict 模式：所有命令执行直接拒绝
      if (getSafetyMode() === "strict") {
        const blocked = await guardDestructiveAction("execute_command", `执行命令: ${command}`);
        if (blocked) return fail(blocked);
      }

      try {
        const result = await safeExec(command, timeout || 30000, cwd);
        const parts: string[] = [];
        parts.push("$ " + command);
        if (result.stdout) parts.push(result.stdout.trim());
        if (result.stderr) parts.push("[STDERR]\n" + result.stderr.trim());
        return ok(parts.join("\n"));
      } catch (e: any) {
        logger.error("execute_command", "failed", e.message);
        return fail("Command failed: " + e.message);
      }
    }
  );

  // ===== Tool 2: batch_execute =====
  server.registerTool(
    "batch_execute",
    {
      title: "Batch Execute Commands",
      description: "Execute multiple commands sequentially, stop on error if needed",
      inputSchema: {
        commands: z.array(z.string()).describe("Array of commands to execute"),
        cwd: z.string().optional().describe("Working directory"),
        stop_on_error: z.boolean().optional().describe("Stop if a command fails, default true"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ commands, cwd, stop_on_error }) => {
      // strict 模式：所有命令执行直接拒绝
      if (getSafetyMode() === "strict") {
        const blocked = await guardDestructiveAction("batch_execute", `批量执行 ${commands.length} 条命令`);
        if (blocked) return fail(blocked);
      }

      const stopOnErr = stop_on_error !== false;
      const results: string[] = [];
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        logger.info("batch_execute", `step ${i + 1}/${commands.length}`, cmd);

        // 硬性底线：每条命令都检查危险模式（所有模式生效）
        if (hasDangerousPattern(cmd)) {
          results.push(`--- [${i + 1}/${commands.length}] $ ${cmd} ---`);
          results.push("[BLOCKED] Dangerous pattern detected");
          if (stopOnErr) { results.push("(Stopped due to blocked command)"); break; }
          continue;
        }

        results.push(`--- [${i + 1}/${commands.length}] $ ${cmd} ---`);
        try {
          const r = await safeExec(cmd, 30000, cwd);
          if (r.stdout) results.push(r.stdout.trim());
          if (r.stderr) results.push("[STDERR] " + r.stderr.trim());
        } catch (e: any) {
          results.push("[FAILED] " + e.message);
          if (stopOnErr) {
            results.push("(Stopped due to error)");
            break;
          }
        }
      }
      return ok(results.join("\n"));
    }
  );

  // ===== Tool 3: watch_command =====
  server.registerTool(
    "watch_command",
    {
      title: "Watch Command",
      description: "Execute a command and capture output for a limited duration",
      inputSchema: {
        command: z.string().describe("The command to run"),
        duration: z.number().optional().describe("Max duration in ms, default 5000"),
        cwd: z.string().optional().describe("Working directory"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ command, duration, cwd }) => {
      logger.info("watch_command", "watch", command);

      // 硬性底线：危险命令直接拒绝（所有模式生效）
      if (hasDangerousPattern(command)) {
        logger.warn("watch_command", "blocked", `Dangerous pattern: ${command}`);
        return fail("Command blocked: contains potentially dangerous pattern.");
      }

      // strict 模式：所有命令执行直接拒绝
      if (getSafetyMode() === "strict") {
        const blocked = await guardDestructiveAction("watch_command", `监视命令: ${command}`);
        if (blocked) return fail(blocked);
      }

      try {
        const ms = Math.min(duration || 5000, 30000);
        const result = await safeExec(command, ms, cwd);
        const parts = ["$ " + command, `(captured for up to ${ms}ms)`];
        if (result.stdout) parts.push(result.stdout.trim());
        if (result.stderr) parts.push("[STDERR]\n" + result.stderr.trim());
        return ok(parts.join("\n"));
      } catch (e: any) {
        if (e.killed) {
          return ok("$ " + command + "\n(timed out)\n" + (e.stdout || ""));
        }
        return fail("Watch failed: " + e.message);
      }
    }
  );
}
