/**
 * path-policy 单元测试：real 解析重验、no-follow 写语义、原子 staging 写、根替换检查
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { assertSafeStateRoot, atomicWriteFile, resolveForRead, resolveForWrite } from "../../src/path-policy.js";

describe("path-policy", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-policy-"));
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  describe("resolveForRead", () => {
    test("resolves an existing regular file to its real path", async () => {
      const file = path.join(workDir, "f.txt");
      await fs.writeFile(file, "data");
      const r = await resolveForRead(file, "read_file", "file_path");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolution.existed).toBe(true);
    });

    test("rejects a symlink resolving into a sensitive directory", async () => {
      const sensitive = path.join(workDir, ".ssh");
      await fs.mkdir(sensitive);
      await fs.writeFile(path.join(sensitive, "id_rsa"), "key");
      const link = path.join(workDir, "innocent-link");
      await fs.symlink(sensitive, link, "junction");

      const r = await resolveForRead(link, "read_file", "file_path");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.result.error?.code).toBe("PATH_FORBIDDEN");
    });

    test("rejects a file symlink whose target is a sensitive file", async () => {
      const envFile = path.join(workDir, ".env");
      await fs.writeFile(envFile, "SECRET=1");
      const link = path.join(workDir, "config-link");
      await fs.symlink(envFile, link);

      const r = await resolveForRead(link, "read_file", "file_path");
      expect(r.ok).toBe(false);
    });

    test("allows a symlink resolving to an ordinary file", async () => {
      const file = path.join(workDir, "plain.txt");
      await fs.writeFile(file, "ok");
      const link = path.join(workDir, "plain-link");
      await fs.symlink(file, link);

      const r = await resolveForRead(link, "read_file", "file_path");
      expect(r.ok).toBe(true);
    });

    test("lets a missing path through for natural ENOENT handling", async () => {
      const missing = path.join(workDir, "nope.txt");
      const r = await resolveForRead(missing, "read_file", "file_path");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.resolution.existed).toBe(false);
    });
  });

  describe("resolveForWrite", () => {
    test("rejects a symlink target outright (no-follow)", async () => {
      const file = path.join(workDir, "real.txt");
      await fs.writeFile(file, "data");
      const link = path.join(workDir, "link.txt");
      await fs.symlink(file, link);

      const r = await resolveForWrite(link, "write_file", "file_path");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.result.error?.message).toMatch(/no-follow/);
    });

    test("rejects a write whose parent chain resolves to a sensitive directory", async () => {
      const sensitive = path.join(workDir, ".aws");
      await fs.mkdir(sensitive);
      const link = path.join(workDir, "parent-link");
      await fs.symlink(sensitive, link, "junction");
      const target = path.join(link, "credentials.txt");

      const r = await resolveForWrite(target, "write_file", "file_path");
      expect(r.ok).toBe(false);
    });

    test("resolves a new file against the parent real path", async () => {
      const sub = path.join(workDir, "sub");
      await fs.mkdir(sub);
      const target = path.join(sub, "new.txt");

      const r = await resolveForWrite(target, "write_file", "file_path");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.resolution.existed).toBe(false);
        expect(r.resolution.real.toLowerCase()).toBe(target.toLowerCase());
      }
    });

    test("lets a missing parent through for mkdir recursive flows", async () => {
      const target = path.join(workDir, "a", "b", "c.txt");
      const r = await resolveForWrite(target, "write_file", "file_path");
      expect(r.ok).toBe(true);
    });

    test("rejects a missing target below a symlinked ancestor into a sensitive directory", async () => {
      const sensitive = path.join(workDir, ".ssh");
      await fs.mkdir(sensitive);
      const link = path.join(workDir, "parent-link");
      await fs.symlink(sensitive, link, "junction");
      const target = path.join(link, "missing", "file.txt");

      const r = await resolveForWrite(target, "write_file", "file_path");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.result.error?.code).toBe("PATH_FORBIDDEN");
        expect(r.result.error?.message).toMatch(/sensitive/);
      }
    });

    test("resolves a missing target below an ordinary symlinked ancestor to the real landing path", async () => {
      const realParent = path.join(workDir, "real-parent");
      await fs.mkdir(realParent);
      const link = path.join(workDir, "parent-link");
      await fs.symlink(realParent, link);
      const target = path.join(link, "missing", "file.txt");

      const r = await resolveForWrite(target, "write_file", "file_path");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.resolution.existed).toBe(false);
        expect(r.resolution.real).toBe(path.join(realParent, "missing", "file.txt"));
      }
    });
  });

  describe("atomicWriteFile", () => {
    test("creates a new file without staging residue", async () => {
      const file = path.join(workDir, "atomic.txt");
      await atomicWriteFile(file, "v1");
      expect(await fs.readFile(file, "utf-8")).toBe("v1");
      const entries = await fs.readdir(workDir);
      expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
    });

    test("replaces an existing file atomically", async () => {
      const file = path.join(workDir, "replace.txt");
      await fs.writeFile(file, "old-content");
      await atomicWriteFile(file, "new-content");
      expect(await fs.readFile(file, "utf-8")).toBe("new-content");
      const entries = await fs.readdir(workDir);
      expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([]);
    });
  });

  describe("assertSafeStateRoot", () => {
    test("passes for an existing directory and for a missing root", async () => {
      await expect(assertSafeStateRoot(workDir)).resolves.toBeUndefined();
      await expect(assertSafeStateRoot(path.join(workDir, "not-yet"))).resolves.toBeUndefined();
    });

    test("throws for a symlinked root", async () => {
      const real = path.join(workDir, "elsewhere");
      await fs.mkdir(real);
      const root = path.join(workDir, "state-root");
      await fs.symlink(real, root, "junction");
      await expect(assertSafeStateRoot(root)).rejects.toThrow(/symlink or not a directory/);
    });

    test("throws for a root that is a plain file", async () => {
      const file = path.join(workDir, "not-a-dir");
      await fs.writeFile(file, "x");
      await expect(assertSafeStateRoot(file)).rejects.toThrow(/symlink or not a directory/);
    });
  });
});
