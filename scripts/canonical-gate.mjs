/**
 * Canonical production gate.
 *
 * The default mode is the release gate: every stage, including latency, is
 * blocking. CI may pass --ci to preserve the existing latency advisory policy
 * while keeping every other stage blocking. Both modes use this one script.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stateRoot = join(projectRoot, ".etmcp");
const gateWorkspace = join(stateRoot, "gate-work");
const reportPath = join(stateRoot, "gate-report.json");
const releaseDir = join(gateWorkspace, "release");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const ciMode = process.argv.slice(2).includes("--ci");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--ci");

if (unknownArgs.length > 0) {
  console.error(`Unknown canonical gate argument(s): ${unknownArgs.join(" ")}`);
  process.exitCode = 2;
} else {
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(gateWorkspace, { recursive: true });

  const env = {
    ...process.env,
    TEMP: join(gateWorkspace, "tmp"),
    TMP: join(gateWorkspace, "tmp"),
    TMPDIR: join(gateWorkspace, "tmp"),
    npm_config_cache: join(gateWorkspace, "npm-cache"),
    MCP_STATE_DIR: join(gateWorkspace, "state"),
    MCP_EXECUTION_PROFILE: "local-trusted-shell",
    ENHANCED_TERMINAL_DISABLE_FILE_INFO: "0",
  };
  mkdirSync(env.TEMP, { recursive: true });
  mkdirSync(env.npm_config_cache, { recursive: true });

  const stages = [];
  let gateFailed = false;
  const startedAt = new Date().toISOString();

  function safeSummary(value) {
    return String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/(api[_-]?key|token|password|secret|credential)=\S+/gi, "$1=[REDACTED]")
      .slice(0, 400);
  }

  function recordSkipped(id, reason) {
    stages.push({ id, status: "skipped", exitCode: null, elapsedMs: 0, detail: reason });
  }

  function quoteWindowsArg(value) {
    const text = String(value);
    if (!/[\s"&|<>^]/.test(text)) return text;
    return `"${text.replaceAll('"', '""')}"`;
  }

  function spawnProcess(command, args, options = {}) {
    if (process.platform === "win32" && /\.cmd$/i.test(command)) {
      const shellCommand = [command, ...args.map(quoteWindowsArg)].join(" ");
      return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", shellCommand], {
        ...options,
        windowsHide: true,
      });
    }
    return spawnSync(command, args, options);
  }

  function runStage(id, command, args, options = {}) {
    if (gateFailed) {
      recordSkipped(id, "previous stage failed");
      return false;
    }

    const started = Date.now();
    console.log(`\n=== gate stage: ${id} ===`);
    const result = spawnProcess(command, args, {
      cwd: projectRoot,
      env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    const elapsedMs = Date.now() - started;
    const exitCode = result.error ? null : result.status ?? 1;
    const failed = result.error !== undefined || exitCode !== 0;
    const advisory = options.advisory === true;
    const status = failed ? (advisory ? "advisory_failed" : "failed") : "passed";
    stages.push({
      id,
      status,
      exitCode,
      elapsedMs,
      ...(result.error ? { detail: safeSummary(result.error.message) } : {}),
    });
    if (failed && !advisory) gateFailed = true;
    return !failed || advisory;
  }

  function packForConsumer() {
    if (gateFailed) {
      recordSkipped("pack-consumer", "previous stage failed");
      return null;
    }

    mkdirSync(releaseDir, { recursive: true });
    const started = Date.now();
    console.log("\n=== gate stage: pack-consumer ===");
    const destination = relative(projectRoot, releaseDir).split(sep).join("/");
    const result = spawnProcess(
      npmCommand,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      {
        cwd: projectRoot,
        env,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
      },
    );
    const elapsedMs = Date.now() - started;
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      stages.push({
        id: "pack-consumer",
        status: "failed",
        exitCode: result.error ? null : result.status,
        elapsedMs,
        detail: safeSummary(result.error?.message ?? result.stderr ?? "npm pack failed"),
      });
      gateFailed = true;
      return null;
    }

    try {
      const output = String(result.stdout ?? "");
      const jsonStart = output.indexOf("[");
      const metadata = JSON.parse(jsonStart >= 0 ? output.slice(jsonStart) : output);
      const filename = metadata?.[0]?.filename;
      if (typeof filename !== "string" || filename.length === 0) throw new Error("npm pack returned no filename");
      const tarballPath = resolve(releaseDir, filename);
      const releasePrefix = `${releaseDir}${sep}`;
      if (!tarballPath.startsWith(releasePrefix) || !existsSync(tarballPath)) {
        throw new Error("npm pack returned a tarball outside the expected release directory");
      }
      stages.push({ id: "pack-consumer", status: "passed", exitCode: 0, elapsedMs, detail: filename });
      return tarballPath;
    } catch (error) {
      stages.push({
        id: "pack-consumer",
        status: "failed",
        exitCode: result.status,
        elapsedMs,
        detail: safeSummary(error instanceof Error ? error.message : error),
      });
      gateFailed = true;
      return null;
    }
  }

  function writeReport(status, exitCode) {
    const report = {
      schemaVersion: 1,
      mode: ciMode ? "ci" : "release",
      status,
      exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
      stages,
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    return report;
  }

  let tarballPath = null;
  try {
    runStage("build", pnpmCommand, ["run", "build"]);
    runStage("typecheck", pnpmCommand, ["exec", "tsc", "--noEmit"]);
    runStage("lint", pnpmCommand, ["run", "lint"]);
    runStage("test", pnpmCommand, ["test"]);
    runStage("coverage-main", pnpmCommand, ["run", "test:coverage"]);
    runStage("coverage-tools", pnpmCommand, ["run", "test:coverage:tools"]);
    runStage("latency", pnpmCommand, ["run", "test:latency"], { advisory: ciMode });
    runStage("dependency-audit", pnpmCommand, ["run", "audit:prod"]);
    runStage("package-verifier", process.execPath, ["scripts/verify-package.mjs"]);
    tarballPath = packForConsumer();
    if (tarballPath) {
      runStage("clean-consumer", process.execPath, ["scripts/verify-clean-consumer.mjs", relative(projectRoot, tarballPath).split(sep).join("/")]);
    } else if (!gateFailed) {
      recordSkipped("clean-consumer", "pack-consumer did not produce a tarball");
    }
  } catch (error) {
    gateFailed = true;
    stages.push({ id: "canonical-gate", status: "failed", exitCode: null, elapsedMs: 0, detail: safeSummary(error) });
  } finally {
    if (releaseDir.startsWith(`${projectRoot}${sep}`) && releaseDir !== projectRoot) {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  }

  const advisoryFailure = stages.some((stage) => stage.status === "advisory_failed");
  const status = gateFailed ? "failed" : advisoryFailure ? "passed_with_advisory" : "passed";
  const exitCode = gateFailed ? 1 : 0;
  const report = writeReport(status, exitCode);
  console.log(`\nCanonical gate ${status}; report: ${reportPath}`);
  process.exitCode = exitCode;
}
