/**
 * Install the packed artifact in an isolated npm consumer and run a startup smoke.
 *
 * This source-only release check intentionally performs no publish or upload.
 * The consumer is created under the project .etmcp directory and removed on exit.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const consumerParent = join(projectRoot, ".etmcp", "release-consumer");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const patchMarker =
  "PATCH: Ensure " + String.fromCharCode(96) + "required" + String.fromCharCode(96) + " is always an array";
let serverProcess = null;

function fail(message) {
  throw new Error(message);
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^]/.test(text)) return text;
  return '"' + text.replaceAll('"', '""') + '"';
}

function npmEnvironment(consumerRoot) {
  const cache = join(projectRoot, ".etmcp", "npm-cache");
  return {
    ...process.env,
    TEMP: consumerRoot,
    TMP: consumerRoot,
    TMPDIR: consumerRoot,
    npm_config_cache: cache,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function runNpmOutput(args, cwd, env) {
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : npmCommand;
  const commandArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", [npmCommand, ...args.map(quoteWindowsArg)].join(" ")]
      : args;
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error) fail("npm could not start: " + String(result.error));
  if (result.status !== 0) {
    fail("npm " + args.join(" ") + " failed: " + String(result.stderr || result.stdout || "unknown error"));
  }
  return String(result.stdout || "");
}

function runNpm(args, cwd, env) {
  runNpmOutput(args, cwd, env);
}

function runNpmJson(args, cwd, env) {
  const output = runNpmOutput(args, cwd, env).trim();
  const jsonStart = output.indexOf("{");
  if (jsonStart < 0) fail("npm " + args.join(" ") + " did not return JSON");
  try {
    return JSON.parse(output.slice(jsonStart));
  } catch (error) {
    fail("npm " + args.join(" ") + " returned invalid JSON: " + String(error));
  }
}

function readInstalledSdk(packageRoot, consumerRoot) {
  const candidates = [
    join(packageRoot, "node_modules", "@modelcontextprotocol", "sdk"),
    join(consumerRoot, "node_modules", "@modelcontextprotocol", "sdk"),
  ];
  for (const candidate of candidates) {
    const manifestPath = join(candidate, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === "@modelcontextprotocol/sdk") return { candidate, manifest };
    }
  }
  return null;
}

function readPatchTarget(sdkRoot) {
  const target = join(sdkRoot, "dist", "esm", "server", "mcp.js");
  if (!existsSync(target)) fail("installed SDK ESM patch target is missing");
  return readFileSync(target, "utf8");
}

function startServer(entryPath, cwd, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    serverProcess = spawn(process.execPath, [entryPath], {
      cwd,
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      if (serverProcess && serverProcess.exitCode === null) resolvePromise();
    }, 800);
    serverProcess.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    serverProcess.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === null && signal) rejectPromise(new Error("server exited during smoke with " + signal));
      else rejectPromise(new Error("server exited during smoke with code " + code));
    });
  });
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const processToStop = serverProcess;
  processToStop.kill();
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 1500);
    processToStop.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  if (processToStop.exitCode === null) processToStop.kill("SIGKILL");
  serverProcess = null;
}

async function main() {
  const tarballArg = process.argv[2];
  if (!tarballArg) fail("usage: node scripts/verify-clean-consumer.mjs <tarball>");
  const tarballPath = resolve(projectRoot, tarballArg);
  if (!existsSync(tarballPath)) fail("tarball does not exist: " + tarballPath);
  if (projectRoot.toUpperCase().startsWith("C:\\")) fail("consumer verifier refuses a C: project root");

  mkdirSync(consumerParent, { recursive: true });
  const consumerRoot = mkdtempSync(join(consumerParent, "consumer-"));
  const env = npmEnvironment(consumerRoot);
  const consumerTarballArg = relative(consumerRoot, tarballPath).split(sep).join("/");
  try {
    runNpm(["init", "-y"], consumerRoot, env);
    runNpm(["install", "@modelcontextprotocol/sdk@1.30.0"], consumerRoot, env);

    const rootSdk = readInstalledSdk(consumerRoot, consumerRoot);
    if (!rootSdk || rootSdk.manifest.version !== "1.30.0") {
      fail("consumer isolation fixture did not install SDK 1.30.0 at the consumer root");
    }
    const rootBefore = readPatchTarget(rootSdk.candidate);

    runNpm(["install", consumerTarballArg], consumerRoot, env);
    const packageRoot = join(consumerRoot, "node_modules", "enhanced-terminal-mcp");
    if (!existsSync(join(packageRoot, "build", "index.js"))) fail("installed package entry is missing");

    const packageSdk = readInstalledSdk(packageRoot, consumerRoot);
    if (!packageSdk || packageSdk.manifest.version !== "1.29.0") {
      fail("package-owned SDK 1.29.0 was not installed separately from the consumer SDK");
    }
    const packagePatched = readPatchTarget(packageSdk.candidate);
    if (!packagePatched.includes(patchMarker)) fail("package-owned SDK was not patched");

    const rootAfter = readPatchTarget(rootSdk.candidate);
    if (rootAfter !== rootBefore) fail("consumer-root SDK was modified by package postinstall");

    const sbom = runNpmJson(["sbom", "--omit=dev", "--sbom-format=cyclonedx"], consumerRoot, env);
    if (
      sbom.bomFormat !== "CycloneDX" ||
      typeof sbom.specVersion !== "string" ||
      !Array.isArray(sbom.components) ||
      sbom.components.length === 0
    ) {
      fail("npm sbom returned no usable CycloneDX production component list");
    }

    await startServer(join(packageRoot, "build", "index.js"), consumerRoot, {
      ...env,
      MCP_AUDIT_MODE: "off",
      MCP_STATE_DIR: join(consumerRoot, "state"),
    });

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          packageVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
          packageSdkVersion: packageSdk.manifest.version,
          consumerSdkVersion: rootSdk.manifest.version,
          checks: {
            packageOwnedPatch: true,
            unrelatedConsumerSdkUnchanged: true,
            productionSbom: true,
            productionSbomComponents: sbom.components.length,
            entryPresent: true,
            startupSmoke: true,
          },
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await stopServer();
    rmSync(consumerRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ) + "\n",
  );
  process.exitCode = 1;
}
