/**
 * Validate the actual npm tarball without adding a runtime dependency.
 *
 * The caller normally runs npm run build first. This script intentionally
 * does not publish, upload, sign, or claim provenance for the package.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
const manifestPath = join(packageRoot, "package.json");
const releaseRoot = join(packageRoot, ".etmcp", "release");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const forbiddenPathPatterns = [
  /^src\//,
  /^tests?\//,
  /^pnpm-lock\.yaml$/,
  /^package-lock\.json$/,
  /^node_modules\//,
  /^\.etmcp\//,
  /^\.serena\//,
  /^\.codegraph\//,
  /^setup\.bat$/,
  /^es_tool\//,
  /^tools\/pwsh\//,
  /^scripts\/clean-build\.mjs$/,
  /\.tgz$/,
];

function fail(message) {
  throw new Error(message);
}

function assertCheck(checks, name, passed, detail) {
  checks[name] = { passed, detail };
  if (!passed) fail(name + ": " + detail);
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("invalid JSON at " + filePath + ": " + String(error));
  }
}

function localPath(relativePath) {
  const normalized = relativePath.split("/").join(sep);
  const absolute = resolve(packageRoot, normalized);
  const rootWithSeparator = packageRoot.endsWith(sep) ? packageRoot : packageRoot + sep;
  if (absolute !== packageRoot && !absolute.startsWith(rootWithSeparator)) {
    fail("package path escapes project root: " + relativePath);
  }
  return absolute;
}

function runNodeCheck(entryPath) {
  const result = spawnSync(process.execPath, ["--check", entryPath], {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TEMP: releaseRoot,
      TMP: releaseRoot,
      TMPDIR: releaseRoot,
      npm_config_cache: join(packageRoot, ".etmcp", "npm-cache"),
    },
  });
  if (result.error) fail("node --check could not start: " + String(result.error));
  if (result.status !== 0) {
    fail("node --check failed: " + String(result.stderr || result.stdout || "unknown error"));
  }
}

function packPackage(packDestination) {
  const packDestinationArg = relative(packageRoot, packDestination).replaceAll("\\", "/");
  const packArgs = ["pack", "--json", "--ignore-scripts", "--pack-destination", packDestinationArg];
  const command = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : npmCommand;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", [npmCommand, ...packArgs].join(" ")] : packArgs;
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TEMP: packDestination,
      TMP: packDestination,
      TMPDIR: packDestination,
      npm_config_cache: join(packageRoot, ".etmcp", "npm-cache"),
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  if (result.error) fail("npm pack could not start: " + String(result.error));
  if (result.status !== 0) {
    fail("npm pack failed: " + String(result.stderr || result.stdout || "unknown error"));
  }
  const output = String(result.stdout || "").trim();
  const jsonStart = output.indexOf("[");
  if (jsonStart < 0) fail("npm pack did not return JSON metadata");
  const metadata = JSON.parse(output.slice(jsonStart));
  if (!Array.isArray(metadata) || metadata.length !== 1 || !metadata[0].filename) {
    fail("npm pack returned an unexpected metadata shape");
  }
  return metadata[0];
}

function main() {
  if (packageRoot.toUpperCase().startsWith("C:\\")) {
    fail("release verifier refuses a C: project root");
  }
  mkdirSync(releaseRoot, { recursive: true });
  const packDestination = mkdtempSync(join(releaseRoot, "verify-"));
  const checks = {};
  try {
    const manifest = readJson(manifestPath);
    assertCheck(checks, "manifest.name", manifest.name === "enhanced-terminal-mcp", String(manifest.name));
    assertCheck(checks, "manifest.main", manifest.main === "build/index.js", String(manifest.main));
    assertCheck(checks, "manifest.types", manifest.types === "build/index.d.ts", String(manifest.types));
    assertCheck(
      checks,
      "manifest.bin",
      manifest.bin && manifest.bin["enhanced-terminal-mcp"] === "build/index.js",
      JSON.stringify(manifest.bin),
    );
    assertCheck(
      checks,
      "manifest.scripts.prepack",
      manifest.scripts && manifest.scripts.prepack === "npm run build",
      String(manifest.scripts && manifest.scripts.prepack),
    );
    assertCheck(
      checks,
      "manifest.scripts.postinstall",
      manifest.scripts && manifest.scripts.postinstall === "node scripts/apply-mcp-sdk-patch.mjs",
      String(manifest.scripts && manifest.scripts.postinstall),
    );
    assertCheck(
      checks,
      "manifest.files",
      JSON.stringify(manifest.files) ===
        JSON.stringify([
          "build/",
          "scripts/apply-mcp-sdk-patch.mjs",
          "README.md",
          "README.zh-CN.md",
          "CHANGELOG.md",
          "LICENSE",
        ]),
      JSON.stringify(manifest.files),
    );

    const metadata = packPackage(packDestination);
    const packedFiles = metadata.files
      .map((entry) => String(entry.path).replaceAll("\\", "/"))
      .sort();
    const requiredFiles = [
      "package.json",
      "README.md",
      "README.zh-CN.md",
      "CHANGELOG.md",
      "LICENSE",
      "scripts/apply-mcp-sdk-patch.mjs",
      "build/index.js",
      "build/index.d.ts",
      "build/index.js.map",
      "build/index.d.ts.map",
    ];
    const missingFiles = requiredFiles.filter((filePath) => !packedFiles.includes(filePath));
    assertCheck(checks, "tarball.required-files", missingFiles.length === 0, JSON.stringify(missingFiles));

    const forbiddenFiles = packedFiles.filter((filePath) =>
      forbiddenPathPatterns.some((pattern) => pattern.test(filePath)),
    );
    assertCheck(checks, "tarball.forbidden-files", forbiddenFiles.length === 0, JSON.stringify(forbiddenFiles));

    const entryPath = localPath("build/index.js");
    const entrySource = readFileSync(entryPath, "utf8");
    assertCheck(
      checks,
      "entry.shebang",
      entrySource.startsWith("#!/usr/bin/env node"),
      entrySource.slice(0, 32),
    );
    runNodeCheck(entryPath);
    checks["entry.node-check"] = { passed: true, detail: "node --check passed" };

    const sourceMapFiles = packedFiles.filter((filePath) => filePath.endsWith(".js.map"));
    const externalSourceMaps = [];
    for (const filePath of sourceMapFiles) {
      const sourceMap = readJson(localPath(filePath));
      if (
        !Array.isArray(sourceMap.sources) ||
        !Array.isArray(sourceMap.sourcesContent) ||
        sourceMap.sourcesContent.length !== sourceMap.sources.length ||
        sourceMap.sourcesContent.some((content) => typeof content !== "string")
      ) {
        externalSourceMaps.push(filePath);
      }
    }
    assertCheck(checks, "source-maps.inline-sources", externalSourceMaps.length === 0, JSON.stringify(externalSourceMaps));

    const tarballPath = join(packDestination, metadata.filename);
    if (!existsSync(tarballPath)) fail("npm pack did not create " + metadata.filename);
    const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
    const result = {
      ok: true,
      package: {
        name: manifest.name,
        version: manifest.version,
        tarball: metadata.filename,
        sha256,
      },
      fileCount: packedFiles.length,
      checks,
    };
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } finally {
    rmSync(packDestination, { recursive: true, force: true });
  }
}

try {
  main();
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
