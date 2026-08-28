/**
 * ZipPolicy 单元测试 — manifest 解析、Zip Slip/link entry/zip bomb 防护、两阶段 staging 解压
 *
 * 测试自建 ZIP 构造器（stored/deflate、可注入谎报大小、unix mode、mismatch local header），
 * 不依赖外部 zip 命令；全部在 .etmcp/test-tmp 下进行。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyEntry,
  extractArchive,
  getArchiveBudgets,
  readManifest,
  validateMemberName,
  type ZipMember,
} from "../../src/zip-policy.js";

const TMP_BASE = fileURLToPath(new URL("../../.etmcp/test-tmp/", import.meta.url));

const ENV_KEYS = [
  "MCP_ARCHIVE_MAX_MEMBERS",
  "MCP_ARCHIVE_MAX_MEMBER_BYTES",
  "MCP_ARCHIVE_MAX_EXPANDED_BYTES",
  "MCP_ARCHIVE_MAX_RATIO",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ====================================================================
// 最小 ZIP 构造器（测试专用）
// ====================================================================

interface ZipEntrySpec {
  name: string;
  data?: Buffer;
  method?: 0 | 8;
  /** external attrs；unix mode 放高 16 位，如 0o120777 << 16 */
  attrs?: number;
  flags?: number;
  /** 覆盖 CD 中声明的展开大小（谎报场景） */
  declaredExpanded?: number;
  declaredCompressed?: number;
  /** 覆盖 local header 中的名字节（mismatch 场景） */
  localNameBytes?: Buffer;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function buildZip(specs: ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const method = spec.method ?? 0;
    const flags = spec.flags ?? 0x0800;
    const data = spec.data ?? Buffer.alloc(0);
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data;
    const nameBytes = spec.localNameBytes ?? Buffer.from(spec.name, "utf-8");
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u32(0),
      u32(0),
      u32(compressed.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]);
    const cdName = Buffer.from(spec.name, "utf-8");
    const cdExtra = Buffer.alloc(0);
    const localOffset = offset;
    const central = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20),
      u16(20),
      u16(flags),
      u16(method),
      u32(0),
      u32(0),
      u32(spec.declaredCompressed ?? compressed.length),
      u32(spec.declaredExpanded ?? data.length),
      u16(cdName.length),
      u16(cdExtra.length),
      u16(0),
      u16(0),
      u16(0),
      u32(spec.attrs ?? 0),
      u32(localOffset),
      cdName,
      cdExtra,
    ]);
    locals.push(localHeader, compressed);
    centrals.push(central);
    offset += localHeader.length + compressed.length;
  }
  const cdStart = offset;
  const cdBuffer = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(specs.length),
    u16(specs.length),
    u32(cdBuffer.length),
    u32(cdStart),
    u16(0),
  ]);
  return Buffer.concat([...locals, cdBuffer, eocd]);
}

function defaultMember(path: string): ZipMember {
  return {
    path,
    kind: "file",
    compressedBytes: 0,
    expandedBytes: 0,
    method: 0,
    flags: 0,
    localHeaderOffset: 0,
    externalAttrs: 0,
    rawName: Buffer.from(path),
  };
}

// ====================================================================
// 成员校验
// ====================================================================

describe("zip-policy member validation", () => {
  test("validateMemberName normalizes backslashes and rejects traversal/absolute/device names", () => {
    expect(validateMemberName("dir\\file.txt")).toBe("dir/file.txt");
    expect(validateMemberName("dir/file.txt")).toBe("dir/file.txt");
    expect(validateMemberName("../evil")).toBeNull();
    expect(validateMemberName("a/../../evil")).toBeNull();
    expect(validateMemberName("/abs/evil")).toBeNull();
    expect(validateMemberName("C:/evil")).toBeNull();
    expect(validateMemberName("C:\\evil")).toBeNull();
    expect(validateMemberName("CON")).toBeNull();
    expect(validateMemberName("dir/NUL.txt")).toBeNull();
    expect(validateMemberName("a\x00b")).toBeNull();
    expect(validateMemberName("x".repeat(1025))).toBeNull();
    expect(validateMemberName("dir/....//ok")).toBe("dir/....//ok"); // 非 ".." 段不是穿越，空段不折叠
  });

  test("classifyEntry rejects symlink/device by unix mode and treats mode 0 as file", () => {
    expect(classifyEntry({ path: "link", externalAttrs: ((0o120777 << 16) >>> 0) | 0 })).toBe("symlink");
    expect(classifyEntry({ path: "dev", externalAttrs: ((0o020600 << 16) >>> 0) | 0 })).toBe("device");
    expect(classifyEntry({ path: "file.txt", externalAttrs: ((0o100644 << 16) >>> 0) | 0 })).toBe("file");
    expect(classifyEntry({ path: "file.txt", externalAttrs: 0x20 })).toBe("file"); // DOS archive 位
    expect(classifyEntry({ path: "dir/", externalAttrs: 0x10 })).toBe("directory");
    expect(classifyEntry(defaultMember("x"))).toBe("file");
  });
});

// ====================================================================
// manifest 与解压
// ====================================================================

describe("zip-policy readManifest and extractArchive", () => {
  let workDir = "";

  async function freshDir(): Promise<string> {
    workDir = await fs.mkdtemp(path.join(TMP_BASE, "zip-"));
    return workDir;
  }

  afterEach(async () => {
    restoreEnv();
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      workDir = "";
    }
  });

  test("normal archive (stored+deflate, nested dirs, utf-8 names) extracts with correct counts", async () => {
    const dir = await freshDir();
    const zipPath = path.join(dir, "ok.zip");
    const payload = Buffer.from("deflate-me ".repeat(50));
    const zip = buildZip([
      { name: "顶层目录/", data: Buffer.alloc(0), method: 0, attrs: 0x10 },
      { name: "顶层目录/nested.txt", data: Buffer.from("nested content"), method: 0 },
      { name: "stored.txt", data: Buffer.from("stored content"), method: 0 },
      { name: "deflated.txt", data: payload, method: 8 },
    ]);
    await fs.writeFile(zipPath, zip);

    const manifest = await readManifest(zipPath);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    expect(manifest.value.members).toHaveLength(4);
    expect(manifest.value.entryCount).toBe(4);

    const outDir = path.join(dir, "out");
    const result = await extractArchive(manifest.value, zipPath, outDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.extracted).toBe(3);
    expect(result.value.bytes).toBe(payload.length + 14 + 14);
    expect((await fs.readFile(path.join(outDir, "顶层目录", "nested.txt"))).toString()).toBe("nested content");
    expect((await fs.readFile(path.join(outDir, "deflated.txt"))).toString()).toBe(payload.toString());
    const staging = await fs.readdir(outDir);
    expect(staging.filter((e) => e.startsWith(".etmcp-extract"))).toEqual([]);
  });

  test("zip slip members are rejected at manifest stage with zero writes", async () => {
    const dir = await freshDir();
    const zipPath = path.join(dir, "evil.zip");
    await fs.writeFile(
      zipPath,
      buildZip([
        { name: "ok.txt", data: Buffer.from("x") },
        { name: "../evil.txt", data: Buffer.from("evil") },
      ]),
    );
    const outDir = path.join(dir, "out");
    await fs.mkdir(outDir);
    const manifest = await readManifest(zipPath);
    expect(manifest.ok).toBe(false);
    if (manifest.ok) return;
    expect(manifest.result.error?.code).toBe("ARCHIVE_LIMIT");
    expect(await fs.readdir(outDir)).toEqual([]); // 零写入
  });

  test("symlink and encrypted entries are rejected", async () => {
    const dir = await freshDir();
    const symlinkZip = path.join(dir, "symlink.zip");
    await fs.writeFile(
      symlinkZip,
      buildZip([{ name: "link", data: Buffer.from("/etc/passwd"), attrs: (0o120777 << 16) >>> 0 }]),
    );
    const symlinkResult = await readManifest(symlinkZip);
    expect(symlinkResult.ok).toBe(false);
    if (!symlinkResult.ok) expect(symlinkResult.result.error?.code).toBe("ARCHIVE_LIMIT");

    const encZip = path.join(dir, "enc.zip");
    await fs.writeFile(encZip, buildZip([{ name: "secret.txt", data: Buffer.from("x"), flags: 0x0801 }]));
    const encResult = await readManifest(encZip);
    expect(encResult.ok).toBe(false);
    if (!encResult.ok) expect(encResult.result.error?.code).toBe("ARCHIVE_LIMIT");
  });

  test("declared-size bombs are caught at manifest stage; actual-stream bombs are caught during extraction", async () => {
    const dir = await freshDir();
    process.env.MCP_ARCHIVE_MAX_MEMBER_BYTES = "1024";
    expect(getArchiveBudgets().maxMemberBytes).toBe(1024);

    // CD 谎报展开 5000 字节 → manifest 阶段拒绝
    const declaredZip = path.join(dir, "declared.zip");
    await fs.writeFile(
      declaredZip,
      buildZip([{ name: "small.txt", data: Buffer.alloc(10, 0x61), declaredExpanded: 5000 }]),
    );
    const declared = await readManifest(declaredZip);
    expect(declared.ok).toBe(false);
    if (!declared.ok) expect(declared.result.error?.code).toBe("ARCHIVE_LIMIT");

    // CD 谎报展开 100 字节，但 deflate 实际展开 10MB → 实时计数阶段拦截
    const big = Buffer.alloc(10 * 1024 * 1024, 0x62);
    const bombZip = path.join(dir, "bomb.zip");
    await fs.writeFile(bombZip, buildZip([{ name: "bomb.txt", data: big, method: 8, declaredExpanded: 100 }]));
    const manifest = await readManifest(bombZip);
    expect(manifest.ok).toBe(true); // 声明值通过预检
    if (!manifest.ok) return;
    const outDir = path.join(dir, "out-bomb");
    await fs.mkdir(outDir);
    const result = await extractArchive(manifest.value, bombZip, outDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.error?.code).toBe("ARCHIVE_LIMIT");
    expect(await fs.readdir(outDir)).toEqual([]); // staging 清理干净
  });

  test("declared high compression ratio bombs are rejected at manifest stage", async () => {
    const dir = await freshDir();
    const zipPath = path.join(dir, "ratio.zip");
    // 展开声明 100MiB（过 64MiB 比例底线）、压缩声明 100KiB → ratio 1024 > 200
    await fs.writeFile(
      zipPath,
      buildZip([
        {
          name: "ratio.txt",
          data: Buffer.from("x"),
          declaredExpanded: 100 * 1024 * 1024,
          declaredCompressed: 100 * 1024,
        },
      ]),
    );
    const manifest = await readManifest(zipPath);
    expect(manifest.ok).toBe(false);
    if (!manifest.ok) expect(manifest.result.error?.code).toBe("ARCHIVE_LIMIT");
  });

  test("local header name mismatch is rejected", async () => {
    const dir = await freshDir();
    const zipPath = path.join(dir, "mismatch.zip");
    await fs.writeFile(
      zipPath,
      buildZip([{ name: "cd-name.txt", data: Buffer.from("x"), localNameBytes: Buffer.from("local-name.txt") }]),
    );
    const manifest = await readManifest(zipPath);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const outDir = path.join(dir, "out");
    await fs.mkdir(outDir);
    const result = await extractArchive(manifest.value, zipPath, outDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.error?.code).toBe("ARCHIVE_FAILED");
    expect(await fs.readdir(outDir)).toEqual([]);
  });

  test("missing archive maps to a structured error", async () => {
    const dir = await freshDir();
    const result = await readManifest(path.join(dir, "missing.zip"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.error?.code).toBe("ARCHIVE_FAILED");
  });
});
