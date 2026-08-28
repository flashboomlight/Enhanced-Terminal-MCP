/**
 * TempManager 跨进程配额 ledger 单元测试（production-hardening #8 / OPS-02）
 *
 * 跨进程 outstanding 经 root/.quota.json 共享；本进程条目以内存 live 值为准。
 * 测试用 process.ppid 充当"确定存活的他人 pid"，用必然不存在的 pid 模拟死进程残留。
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetStateDirCache } from "../../src/state-dir.js";
import { TempManager } from "../../src/temp-manager.js";

describe("temp cross-process quota", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tmpStateDir: string;

  beforeEach(async () => {
    for (const key of ["MCP_STATE_DIR", "MCP_TEMP_MAX_TOTAL_BYTES"]) {
      savedEnv[key] = process.env[key];
    }
    tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-temp-quota-"));
    process.env.MCP_STATE_DIR = tmpStateDir;
    process.env.MCP_TEMP_MAX_TOTAL_BYTES = "1000";
    resetStateDirCache();
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetStateDirCache();
    await fs.rm(tmpStateDir, { recursive: true, force: true });
  });

  const ledgerPath = () => path.join(tmpStateDir, "temp", ".quota.json");

  async function seedLedger(reservations: Record<string, { pid: number; bytes: number; at: number }>): Promise<void> {
    await fs.mkdir(path.join(tmpStateDir, "temp"), { recursive: true });
    await fs.writeFile(ledgerPath(), JSON.stringify({ reservations }), "utf-8");
  }

  test("foreign live outstanding blocks a reserve that would exceed the shared budget", async () => {
    const tm = new TempManager();
    await tm.create("seed");
    // process.ppid 在测试进程生命周期内必然存活：视为"另一个进程"的有效预留
    await seedLedger({ ghost: { pid: process.ppid, bytes: 700, at: Date.now() } });
    await expect(tm.reserve("too-much", 500)).rejects.toMatchObject({ code: "temp_capacity_exceeded" });
    const ok = await tm.reserve("fits", 200);
    expect(ok.reservedBytes).toBe(200);
    await ok.release();
  });

  test("releasing the foreign budget allows the reserve afterwards", async () => {
    const tm = new TempManager();
    await tm.create("seed");
    await seedLedger({ ghost: { pid: process.ppid, bytes: 700, at: Date.now() } });
    await expect(tm.reserve("x", 500)).rejects.toMatchObject({ code: "temp_capacity_exceeded" });
    await seedLedger({});
    const res = await tm.reserve("x", 500);
    expect(res.reservedBytes).toBe(500);
    await res.release();
  });

  test("dead-owner ledger residue is recycled instead of blocking forever", async () => {
    const tm = new TempManager();
    await tm.create("seed");
    await seedLedger({ corpse: { pid: 3999999, bytes: 900, at: Date.now() } });
    const res = await tm.reserve("after-corpse", 500);
    expect(res.reservedBytes).toBe(500);
    await res.release();
    const ledger = JSON.parse(await fs.readFile(ledgerPath(), "utf-8")) as {
      reservations: Record<string, unknown>;
    };
    expect(ledger.reservations.corpse).toBeUndefined();
  });

  test("own reservation is mirrored into the shared ledger for other processes", async () => {
    const tm = new TempManager();
    await tm.create("seed");
    const res = await tm.reserve("mine", 300);
    const ledger = JSON.parse(await fs.readFile(ledgerPath(), "utf-8")) as {
      reservations: Record<string, { pid: number; bytes: number }>;
    };
    expect(ledger.reservations.mine).toMatchObject({ pid: process.pid, bytes: 300 });
    await res.release();
  });

  test("capacity rejection flips temp health to degraded", async () => {
    const tm = new TempManager();
    await tm.create("seed");
    expect(tm.health().state).toBe("healthy");
    await seedLedger({ ghost: { pid: process.ppid, bytes: 990, at: Date.now() } });
    await expect(tm.reserve("y", 100)).rejects.toMatchObject({ code: "temp_capacity_exceeded" });
    expect(tm.health().state).toBe("degraded");
    expect(tm.health().capacityExceededRecent).toBe(true);
  });
});
