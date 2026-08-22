/**
 * Workspace-delete preview, snapshot binding, and serialized deletion.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasReparsePath, isHeadlessPolicyEnabled, validateHeadlessDeleteTarget } from "./headless-policy.js";
import { normalizePath } from "./security.js";

const MAX_PREVIEW_ENTRIES = 100_000;
const PREVIEW_BUDGET_MS = 30_000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;

export type DeleteEntryType = "file" | "directory";

export interface DeleteSnapshot {
  algorithm: "sha256-lstat-v1";
  entry_count: number;
  digest: string;
}

export interface DeletePreview {
  path: string;
  type: DeleteEntryType;
  recursive: boolean;
  file_count: number;
  directory_count: number;
  total_bytes: number;
  snapshot: DeleteSnapshot;
  preview_id: string;
  expires_at: string;
}

export type WorkspaceDeleteErrorCode = "SAFETY_BLOCKED" | "VALIDATION_ERROR" | "PATH_NOT_FOUND";

export class WorkspaceDeleteError extends Error {
  constructor(
    public readonly code: WorkspaceDeleteErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
    public readonly retryable = false,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = "WorkspaceDeleteError";
  }
}

interface SnapshotEntry {
  relativePath: string;
  type: DeleteEntryType;
  size: bigint;
  mtimeNs: bigint;
  isReparse: false;
}

interface PreviewRecord extends DeletePreview {
  normalizedPath: string;
}

interface SnapshotResult {
  path: string;
  type: DeleteEntryType;
  recursive: boolean;
  file_count: number;
  directory_count: number;
  total_bytes: number;
  snapshot: DeleteSnapshot;
}

const previews = new Map<string, PreviewRecord>();
let mutationTail: Promise<void> = Promise.resolve();

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = normalizePath(value).replace(/[\\/]$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function relativePath(root: string, current: string): string {
  const relative = path.relative(root, current).split(path.sep).join("/");
  return relative.length === 0 ? "." : relative;
}

function checkBudget(deadline: number, entries: SnapshotEntry[]): void {
  if (entries.length >= MAX_PREVIEW_ENTRIES) {
    throw new WorkspaceDeleteError(
      "VALIDATION_ERROR",
      `Delete preview exceeds the ${MAX_PREVIEW_ENTRIES} entry budget`,
      { reason: "preview_budget_exceeded", max_entries: MAX_PREVIEW_ENTRIES },
      true,
      "Reduce the target scope and retry delete_preview",
    );
  }
  if (Date.now() > deadline) {
    throw new WorkspaceDeleteError(
      "VALIDATION_ERROR",
      `Delete preview exceeded the ${PREVIEW_BUDGET_MS}ms budget`,
      { reason: "preview_budget_exceeded", budget_ms: PREVIEW_BUDGET_MS },
      true,
      "Reduce the target scope and retry delete_preview",
    );
  }
}

function canonicalEntry(entry: SnapshotEntry): string {
  return JSON.stringify([
    entry.relativePath,
    entry.type,
    entry.size.toString(),
    entry.mtimeNs.toString(),
    entry.isReparse,
  ]);
}

function buildSnapshotDigest(entries: SnapshotEntry[]): DeleteSnapshot {
  const lines = [...entries]
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")),
    )
    .map(canonicalEntry);
  return {
    algorithm: "sha256-lstat-v1",
    entry_count: entries.length,
    digest: createHash("sha256").update(lines.join("\n"), "utf8").digest("hex"),
  };
}

async function collectSnapshot(targetPath: string, recursive: boolean): Promise<SnapshotResult> {
  const normalizedPath = normalizePath(targetPath);
  let rootStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    rootStat = await fs.lstat(normalizedPath, { bigint: true });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      throw new WorkspaceDeleteError("PATH_NOT_FOUND", `Not found: ${targetPath}`, undefined, true);
    }
    throw error;
  }

  if (rootStat.isSymbolicLink() || (await hasReparsePath(normalizedPath))) {
    throw new WorkspaceDeleteError("SAFETY_BLOCKED", `Delete target is a reparse point: ${targetPath}`);
  }
  const rootIsDirectory = rootStat.isDirectory();
  if (!rootIsDirectory && !rootStat.isFile()) {
    throw new WorkspaceDeleteError("SAFETY_BLOCKED", `Delete target is not a regular file or directory: ${targetPath}`);
  }
  if (rootIsDirectory && !recursive) {
    const children = await fs.readdir(normalizedPath);
    if (children.length > 0) {
      throw new WorkspaceDeleteError(
        "VALIDATION_ERROR",
        `Cannot preview non-empty directory without recursive=true: ${targetPath}`,
        { param: "recursive" },
        true,
        "Set recursive=true and retry delete_preview",
      );
    }
  }
  if (!rootIsDirectory && recursive) {
    throw new WorkspaceDeleteError(
      "VALIDATION_ERROR",
      `recursive=true is only valid for directories: ${targetPath}`,
      { param: "recursive" },
      true,
      "Set recursive=false for a file",
    );
  }

  const entries: SnapshotEntry[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0n;
  const deadline = Date.now() + PREVIEW_BUDGET_MS;

  const visit = async (currentPath: string, relative: string): Promise<void> => {
    checkBudget(deadline, entries);
    const stat = await fs.lstat(currentPath, { bigint: true });
    if (stat.isSymbolicLink() || (await hasReparsePath(currentPath))) {
      throw new WorkspaceDeleteError("SAFETY_BLOCKED", `Delete tree contains a reparse point: ${currentPath}`);
    }
    const type: DeleteEntryType | null = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
    if (!type) {
      throw new WorkspaceDeleteError("SAFETY_BLOCKED", `Delete tree contains an unsupported entry: ${currentPath}`);
    }
    entries.push({
      relativePath: relative,
      type,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      isReparse: false,
    });
    if (type === "directory") directoryCount++;
    else {
      fileCount++;
      totalBytes += stat.size;
    }
    if (type !== "directory" || !recursive) return;
    const children = await fs.readdir(currentPath, { withFileTypes: true });
    for (const child of children) {
      await visit(path.join(currentPath, child.name), relativePath(normalizedPath, path.join(currentPath, child.name)));
    }
  };

  await visit(normalizedPath, ".");
  if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new WorkspaceDeleteError(
      "VALIDATION_ERROR",
      "Delete preview total_bytes exceeds the safe JSON integer range",
      { reason: "preview_budget_exceeded" },
      true,
    );
  }
  return {
    path: normalizedPath,
    type: rootIsDirectory ? "directory" : "file",
    recursive,
    file_count: fileCount,
    directory_count: directoryCount,
    total_bytes: Number(totalBytes),
    snapshot: buildSnapshotDigest(entries),
  };
}

/** 清扫已过期的 preview 记录，避免长寿命进程下 Map 无界增长 */
function sweepExpiredPreviews(): void {
  const now = Date.now();
  for (const [id, preview] of previews) {
    if (now >= Date.parse(preview.expires_at)) previews.delete(id);
  }
}

/**
 * Build and retain a short-lived preview for a delete operation.
 */
export async function createDeletePreview(targetPath: string, recursive: boolean): Promise<DeletePreview> {
  sweepExpiredPreviews();
  if (isHeadlessPolicyEnabled()) {
    const boundaryError = await validateHeadlessDeleteTarget(targetPath);
    if (boundaryError) throw new WorkspaceDeleteError("SAFETY_BLOCKED", boundaryError);
  }
  const result = await collectSnapshot(targetPath, recursive);
  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  const preview: PreviewRecord = {
    ...result,
    preview_id: previewId,
    expires_at: expiresAt.toISOString(),
    normalizedPath: result.path,
  };
  previews.set(previewId, preview);
  const { normalizedPath: _normalizedPath, ...publicPreview } = preview;
  return publicPreview;
}

async function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = mutationTail;
  let release!: () => void;
  mutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function previewFailure(message: string, detail?: Record<string, unknown>): WorkspaceDeleteError {
  return new WorkspaceDeleteError("VALIDATION_ERROR", message, detail, true, "Run delete_preview again");
}

/**
 * Revalidate a preview and perform exactly one headless deletion.
 */
export async function deleteWithPreview(
  targetPath: string,
  recursive: boolean,
  previewId: string,
): Promise<{ path: string; type: DeleteEntryType }> {
  return withMutationLock(async () => {
    const preview = previews.get(previewId);
    if (!preview) throw previewFailure("Preview id is invalid, expired, used, or belongs to another server process");
    previews.delete(previewId);
    if (Date.now() >= Date.parse(preview.expires_at)) throw previewFailure("Preview id has expired");
    if (!samePath(preview.normalizedPath, targetPath) || preview.recursive !== recursive) {
      throw previewFailure("Delete request does not match the preview", { reason: "preview_mismatch" });
    }
    const boundaryError = await validateHeadlessDeleteTarget(targetPath);
    if (boundaryError) throw new WorkspaceDeleteError("SAFETY_BLOCKED", boundaryError);
    const current = await collectSnapshot(targetPath, recursive);
    if (current.snapshot.digest !== preview.snapshot.digest) {
      throw previewFailure("Delete target changed after preview", { reason: "preview_stale" });
    }

    if (current.type === "directory") {
      await fs.rm(current.path, { recursive: true, force: true });
    } else {
      await fs.unlink(current.path);
    }
    return { path: current.path, type: current.type };
  });
}

export function resetWorkspaceDeleteStateForTests(): void {
  previews.clear();
  mutationTail = Promise.resolve();
}
