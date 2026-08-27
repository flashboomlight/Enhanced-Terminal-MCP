/**
 * command-risk.ts 语料驱动单测 —— 语料来源 tests/fixtures/command-risk-corpus.json
 * 对应 design 2026-08-28-command-risk-gated-confirmation §3 / P1 / P3：
 * 规则表（词表/阈值/正则）的任何改动必须保持本测试通过。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CommandConfirmationMode } from "../../src/command-risk.js";

interface Corpus {
  ordinary: string[];
  heavyDestructive: string[];
  heavyPerformance: string[];
  policyRejected: string[];
  batchThreshold: number;
  watchThresholdMs: number;
}

const corpus = JSON.parse(
  await fs.readFile(path.resolve("tests/fixtures/command-risk-corpus.json"), "utf-8"),
) as Corpus;

describe("parseCommandConfirmationMode", () => {
  test("未设置默认 all（向后兼容）", async () => {
    const { parseCommandConfirmationMode } = await import("../../src/command-risk.js");
    expect(parseCommandConfirmationMode(undefined)).toBe<CommandConfirmationMode>("all");
  });

  test("合法值 risk-gated 生效", async () => {
    const { parseCommandConfirmationMode } = await import("../../src/command-risk.js");
    expect(parseCommandConfirmationMode("risk-gated")).toBe("risk-gated");
  });

  test("非法值回退 all 并告警（A13）", async () => {
    const { parseCommandConfirmationMode } = await import("../../src/command-risk.js");
    const warn = vi.fn();
    expect(parseCommandConfirmationMode("什么", warn)).toBe("all");
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("classifyCommandRisk 语料", () => {
  beforeEach(() => {
    delete process.env.MCP_COMMAND_CONFIRMATION;
  });
  afterEach(() => {
    delete process.env.MCP_COMMAND_CONFIRMATION;
  });

  test("ordinary 组全部免确认（A2/A3）", async () => {
    const { classifyCommandRisk } = await import("../../src/command-risk.js");
    for (const command of corpus.ordinary) {
      const risk = classifyCommandRisk(command, { tool: "execute_command" });
      expect(risk.level, `expect ordinary: ${command}`).toBe("ordinary");
    }
  });

  test("破坏类残余全部 heavy（A6/P1 相对路径与非根绝对路径）", async () => {
    const { classifyCommandRisk } = await import("../../src/command-risk.js");
    for (const command of corpus.heavyDestructive) {
      const risk = classifyCommandRisk(command, { tool: "execute_command" });
      expect(risk.level, `expect heavy: ${command}`).toBe("heavy");
      expect(risk.category, `expect destructive: ${command}`).toBe("destructive");
    }
  });

  test("性能类词表全部 heavy（D4）", async () => {
    const { classifyCommandRisk } = await import("../../src/command-risk.js");
    for (const command of corpus.heavyPerformance) {
      const risk = classifyCommandRisk(command, { tool: "execute_command" });
      expect(risk.level, `expect heavy: ${command}`).toBe("heavy");
      expect(risk.category, `expect performance: ${command}`).toBe("performance");
    }
  });

  test("policy 组在策略层被直接拒绝，不进入分级（P1 分界/A7/R5）", async () => {
    const { checkCommandPolicy } = await import("../../src/command-policy.js");
    for (const command of corpus.policyRejected) {
      expect(checkCommandPolicy(command), `expect policy reject: ${command}`).not.toBeNull();
    }
  });

  test("batch 阈值边界：5 条免确认，6 条整批 heavy（A4/A5/D3）", async () => {
    const { classifyBatchRisk, classifyCommandRisk } = await import("../../src/command-risk.js");
    const mk = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`);
    expect(classifyCommandRisk("echo 0", { tool: "batch_execute", batchSize: corpus.batchThreshold }).level).toBe(
      "ordinary",
    );
    expect(classifyCommandRisk("echo 0", { tool: "batch_execute", batchSize: corpus.batchThreshold + 1 }).level).toBe(
      "heavy",
    );
    expect(classifyBatchRisk(mk(corpus.batchThreshold)).level).toBe("ordinary");
    expect(classifyBatchRisk(mk(corpus.batchThreshold + 1))).toMatchObject({ level: "heavy", category: "batch" });
  });

  test("batch 内任一 heavy 条目带原因整批 heavy", async () => {
    const { classifyBatchRisk } = await import("../../src/command-risk.js");
    const commands = ["echo 1", "echo 2", "git clean -fdx", "echo 4"];
    expect(classifyBatchRisk(commands)).toMatchObject({ level: "heavy", category: "destructive" });
  });

  test("watch 阈值：缺省/短时长免确认，超阈值 heavy（A8/D4）", async () => {
    const { classifyCommandRisk } = await import("../../src/command-risk.js");
    expect(classifyCommandRisk("tail -f app.log", { tool: "watch_command" }).level).toBe("ordinary");
    expect(
      classifyCommandRisk("tail -f app.log", { tool: "watch_command", durationMs: corpus.watchThresholdMs }).level,
    ).toBe("ordinary");
    expect(
      classifyCommandRisk("tail -f app.log", { tool: "watch_command", durationMs: corpus.watchThresholdMs + 1 }),
    ).toMatchObject({ level: "heavy", category: "watch" });
  });
});
