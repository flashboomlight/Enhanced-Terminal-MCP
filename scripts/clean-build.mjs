import { existsSync, rmSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = resolve(projectRoot, "build");
const allowedPrefix = `${projectRoot}${sep}`;

if (!buildDir.startsWith(allowedPrefix) || buildDir === projectRoot) {
  throw new Error(`Refusing to clean a path outside the project build directory: ${buildDir}`);
}

if (existsSync(buildDir)) {
  rmSync(buildDir, { recursive: true, force: true });
}
