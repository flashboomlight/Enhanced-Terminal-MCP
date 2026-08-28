import type { ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";
import { execFileManaged, ProcessSupervisor } from "../../src/process-supervisor.js";

function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", resolve));
}

describe("ProcessSupervisor", () => {
  test("registers a child and removes it after close", async () => {
    const supervisor = new ProcessSupervisor({ maxActiveProcesses: 2 });
    const managed = supervisor.spawnManaged(process.execPath, ["-e", "process.stdout.write('ok')"], {
      kind: "unit",
      tree: false,
    });

    expect(supervisor.activeCount).toBe(1);
    expect(managed.snapshot.kind).toBe("unit");
    expect(managed.snapshot.pid).toBeGreaterThan(0);
    expect(managed.snapshot).not.toHaveProperty("command");
    expect(managed.snapshot).not.toHaveProperty("env");
    await waitForClose(managed.child);
    expect(supervisor.activeCount).toBe(0);
    expect(supervisor.getActiveSnapshots()).toEqual([]);
  });

  test("enforces the active process limit before spawning the second child", async () => {
    const supervisor = new ProcessSupervisor({ maxActiveProcesses: 1 });
    const first = supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      kind: "first",
      tree: false,
    });

    expect(() =>
      supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        kind: "second",
        tree: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT" }));

    await first.terminate("internal-error");
    await waitForClose(first.child);
    expect(supervisor.activeCount).toBe(0);
  });

  test("timeout marks state and terminates a long-running child", async () => {
    const supervisor = new ProcessSupervisor({ graceMs: 20, forceWaitMs: 200 });
    const managed = supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      kind: "timeout",
      tree: false,
      timeoutMs: 50,
    });

    await waitForClose(managed.child);
    expect(managed.state.timedOut).toBe(true);
    expect(managed.state.terminated).toBe(true);
    expect(managed.state.terminationFailed).toBe(false);
    expect(supervisor.activeCount).toBe(0);
  });

  test("AbortSignal marks cancellation and terminates the child", async () => {
    const supervisor = new ProcessSupervisor({ graceMs: 20, forceWaitMs: 200 });
    const controller = new AbortController();
    const managed = supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      kind: "cancel",
      tree: false,
      signal: controller.signal,
    });

    controller.abort();
    await waitForClose(managed.child);
    expect(managed.state.cancelled).toBe(true);
    expect(managed.state.reason).toBe("cancelled");
    expect(supervisor.activeCount).toBe(0);
  });

  test("assigns a platform tree scope and terminates only the registered PID", async () => {
    const treePids: number[] = [];
    const supervisor = new ProcessSupervisor({
      graceMs: 20,
      forceWaitMs: 200,
      killTree: async (pid) => {
        treePids.push(pid);
        return true;
      },
    });
    const managed = supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      kind: "tree",
      tree: true,
    });

    const expectedPrefix = process.platform === "win32" ? "windows-tree:" : "unix-process-group:";
    expect(managed.snapshot.treeScope).toBe(expectedPrefix + managed.snapshot.pid);
    await managed.terminate("output-limit");
    await waitForClose(managed.child);
    if (process.platform === "win32") expect(treePids).toEqual([managed.snapshot.pid]);
    else expect(treePids).toEqual([]);
    expect(supervisor.activeCount).toBe(0);
  });

  test("does not spawn when the signal is already aborted", () => {
    const supervisor = new ProcessSupervisor();
    const controller = new AbortController();
    controller.abort();

    expect(() =>
      supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        signal: controller.signal,
      }),
    ).toThrowError(expect.objectContaining({ code: "ABORT_ERR" }));
    expect(supervisor.activeCount).toBe(0);
  });

  test("termination is idempotent and shutdown drains the registry", async () => {
    const supervisor = new ProcessSupervisor({ graceMs: 20, forceWaitMs: 200 });
    const managed = supervisor.spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      kind: "shutdown",
      tree: false,
    });

    const first = managed.terminate("cancelled");
    const second = managed.terminate("shutdown");
    expect(first).toBe(second);
    await first;
    await waitForClose(managed.child);
    const report = await supervisor.shutdown(1000);
    expect(report.clean).toBe(true);
    expect(report.remaining).toEqual([]);
    expect(report.deadlineExceeded).toBe(false);
    expect(await supervisor.shutdown(1000)).toBe(report);
  });

  test("execFileManaged returns output while tracking the child", async () => {
    const result = await execFileManaged(process.execPath, ["-e", "process.stdout.write('managed')"], {
      kind: "exec-file-unit",
      tree: false,
      timeoutMs: 1000,
    });

    expect(result.stdout).toBe("managed");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.terminationFailed).toBe(false);
  });
});
