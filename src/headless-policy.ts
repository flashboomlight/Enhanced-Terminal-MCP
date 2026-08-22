/**
 * Headless workspace-delete policy: trusted roots and reparse-safe target checks.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./logger.js";
import { isForbiddenPath, isSensitivePath, normalizePath, validatePath } from "./security.js";

export interface HeadlessRoot {
  configuredPath: string;
  realPath: string;
}

export interface HeadlessPolicySummary {
  configured: boolean;
  rootCount: number;
  surface: "workspace-delete" | "none";
}

export const HEADLESS_CONFIG_ERROR = "HEADLESS_CONFIG_ERROR";

let initialized = false;
let headlessEnabled = false;
let roots: HeadlessRoot[] = [];

function isHeadlessEnv(): boolean {
  return (process.env.MCP_CONFIRMATION_MODE || "elicitation").toLowerCase().trim() === "headless";
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = normalizePath(value).replace(/[\\/]$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export async function hasReparsePath(targetPath: string): Promise<boolean> {
  const stat = await fs.lstat(targetPath);
  if (stat.isSymbolicLink()) return true;
  const realPath = await fs.realpath(targetPath);
  return !samePath(targetPath, realPath);
}

function configError(message: string): Error {
  const error = new Error(`${HEADLESS_CONFIG_ERROR}: ${message}`);
  (error as NodeJS.ErrnoException).code = HEADLESS_CONFIG_ERROR;
  return error;
}

async function validateRoot(configuredPath: string): Promise<HeadlessRoot> {
  if (!path.isAbsolute(configuredPath)) {
    throw configError(`MCP_ALLOWED_ROOTS requires absolute paths: ${configuredPath}`);
  }
  const pathError = validatePath(configuredPath, "headless:allowed_root");
  if (pathError) throw configError(pathError);

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(configuredPath);
  } catch (error) {
    throw configError(`MCP_ALLOWED_ROOTS path is unavailable: ${configuredPath} (${String(error)})`);
  }
  if (!stat.isDirectory()) throw configError(`MCP_ALLOWED_ROOTS path is not a directory: ${configuredPath}`);
  if (await hasReparsePath(configuredPath)) {
    throw configError(`MCP_ALLOWED_ROOTS path resolves through a reparse point: ${configuredPath}`);
  }

  const realPath = await fs.realpath(configuredPath);
  if (isForbiddenPath(realPath) || isSensitivePath(realPath)) {
    throw configError(`MCP_ALLOWED_ROOTS path is protected or sensitive: ${configuredPath}`);
  }
  return { configuredPath: normalizePath(configuredPath), realPath: normalizePath(realPath) };
}

/**
 * Validate and cache the headless workspace policy during server startup.
 */
export async function initHeadlessPolicy(): Promise<void> {
  initialized = true;
  headlessEnabled = isHeadlessEnv();
  roots = [];
  if (!headlessEnabled) return;

  const raw = process.env.MCP_ALLOWED_ROOTS;
  if (raw === undefined || raw.trim().length === 0) {
    throw configError("MCP_ALLOWED_ROOTS is required when MCP_CONFIRMATION_MODE=headless");
  }
  const entries = raw.split(path.delimiter);
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw configError("MCP_ALLOWED_ROOTS cannot contain empty entries");
  }
  roots = await Promise.all(entries.map((entry) => validateRoot(entry.trim())));
  logger.info("headless-policy", "initialized", `workspace-delete roots=${roots.length}`);
}

export function isHeadlessPolicyEnabled(): boolean {
  return headlessEnabled;
}

export function getHeadlessPolicySummary(): HeadlessPolicySummary {
  return {
    configured: initialized && headlessEnabled,
    rootCount: initialized && headlessEnabled ? roots.length : 0,
    surface: initialized && headlessEnabled ? "workspace-delete" : "none",
  };
}

function isStrictDescendant(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

/**
 * Check an existing delete target and its parent against the trusted roots.
 */
export async function validateHeadlessDeleteTarget(targetPath: string): Promise<string | null> {
  if (!headlessEnabled) return null;
  let realTarget: string;
  try {
    realTarget = normalizePath(await fs.realpath(targetPath));
  } catch {
    return `Headless delete target is not available: ${targetPath}`;
  }

  try {
    if (await hasReparsePath(targetPath)) {
      return `Headless delete target is a reparse point: ${targetPath}`;
    }
    const parentPath = path.dirname(targetPath);
    if (await hasReparsePath(parentPath)) {
      return `Headless delete parent is a reparse point: ${parentPath}`;
    }
  } catch (error) {
    return `Headless delete target could not be inspected: ${targetPath} (${String(error)})`;
  }

  const matchingRoot = roots.find((root) => isStrictDescendant(root.realPath, realTarget));
  if (!matchingRoot) {
    return `Headless delete target must be a strict descendant of an allowed root: ${targetPath}`;
  }
  return null;
}

export function resetHeadlessPolicyForTests(): void {
  initialized = false;
  headlessEnabled = false;
  roots = [];
}
