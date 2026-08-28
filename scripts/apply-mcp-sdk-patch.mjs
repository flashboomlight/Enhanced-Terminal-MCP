/**
 * 零依赖 postinstall：为 @modelcontextprotocol/sdk 补上 object schema 的 required: []
 * 替代 patch-package，避免将 patch-package 放进 production dependencies。
 *
 * 失败语义（fail-closed，2026-08-28 加固）：
 * - SDK 已安装但 esm/cjs 两个 server/mcp.js 都找不到 → 布局已变、补丁无法确认，报错并以退出码 1 结束，
 *   防止兼容补丁静默失效造成 outputSchema 行为回退；
 * - 目标文件存在但内部模式失配（SDK internals changed）→ 报错并以退出码 1 结束；
 * - SDK 完全未安装（异常安装环境）→ 记录后跳过，不阻断安装。
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdkPackageRel = ["node_modules", "@modelcontextprotocol", "sdk"];
const targetRel = (flavor) => ["dist", flavor, "server", "mcp.js"];
const sdkPackageName = "@modelcontextprotocol/sdk";
const supportedSdkVersion = "1.29.0";

function findSdkPackageRoot(startPath) {
  let current = resolve(startPath);
  while (true) {
    const manifestPath = join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name === sdkPackageName) return current;
      } catch {
        // A malformed package manifest is handled by the caller as unavailable.
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveOwnedSdkRoot() {
  const localRoot = findSdkPackageRoot(join(packageRoot, ...sdkPackageRel));
  if (localRoot) return localRoot;

  const configuredRoots = [process.env.INIT_CWD, process.env.npm_config_local_prefix]
    .filter((value) => typeof value === "string" && value.length > 0)
    .map((value) => resolve(value))
    .filter((value, index, values) => values.indexOf(value) === index);

  for (const root of configuredRoots) {
    const configuredSdkRoot = findSdkPackageRoot(join(root, ...sdkPackageRel));
    if (configuredSdkRoot) return configuredSdkRoot;
  }

  return null;
}

const MARKER = "PATCH: Ensure `required` is always an array";

function patchFile(filePath) {
  if (!existsSync(filePath)) return { filePath, status: "missing" };
  let src = readFileSync(filePath, "utf8");
  if (src.includes(MARKER)) return { filePath, status: "already" };

  let changed = false;

  // EMPTY_OBJECT_JSON_SCHEMA: add required: []
  const emptyOld = /const EMPTY_OBJECT_JSON_SCHEMA = \{\s*type: ['"]object['"],\s*properties: \{\s*\}\s*\};/;
  if (emptyOld.test(src)) {
    src = src.replace(
      emptyOld,
      `const EMPTY_OBJECT_JSON_SCHEMA = {\n    type: 'object',\n    properties: {},\n    // ${MARKER}\n    required: []\n};`,
    );
    changed = true;
  }

  // After toJsonSchemaCompat / toJsonSchemaCompat call return, inject required guard
  // Match both ESM and CJS shapes around schema conversion return
  const inject = `
                        // ${MARKER}
                        if (schema && schema.type === 'object' && !Object.prototype.hasOwnProperty.call(schema, 'required')) {
                            schema.required = [];
                        }
                        return schema;`;

  // Pattern: return obj ? toJsonSchema...(obj, {...}) : EMPTY...
  const returnPatterns = [
    /return obj\s*\?\s*toJsonSchemaCompat\(obj,\s*\{[\s\S]*?\}\)\s*:\s*EMPTY_OBJECT_JSON_SCHEMA;/,
    /return obj\s*\?\s*\(0,\s*zod_json_schema_compat_js_1\.toJsonSchemaCompat\)\(obj,\s*\{[\s\S]*?\}\)\s*:\s*EMPTY_OBJECT_JSON_SCHEMA;/,
  ];

  for (const re of returnPatterns) {
    if (re.test(src)) {
      src = src.replace(
        re,
        (m) =>
          `const schema = ${m.replace(/^return\s+/, "").replace(/;$/, "")};${inject}`,
      );
      changed = true;
      break;
    }
  }

  if (!changed) return { filePath, status: "mismatch" };
  const tempPath = filePath + ".etmcp-patch-" + process.pid + "-" + Date.now();
  try {
    writeFileSync(tempPath, src, "utf8");
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original write failure; best-effort cleanup is sufficient here.
    }
    throw error;
  }
  return { filePath, status: "patched" };
}

const sdkRoot = resolveOwnedSdkRoot();

if (!sdkRoot) {
  console.log("[apply-mcp-sdk-patch] @modelcontextprotocol/sdk not found; nothing to patch");
} else {
  let hardFailure = false;
  const manifestPath = join(sdkRoot, "package.json");
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.error(
      "[apply-mcp-sdk-patch] ERROR: package-owned @modelcontextprotocol/sdk package.json is unreadable.",
    );
    hardFailure = true;
  }

  if (manifest && manifest.version && manifest.version !== supportedSdkVersion) {
    console.error(
      "[apply-mcp-sdk-patch] ERROR: unsupported package-owned @modelcontextprotocol/sdk version " +
        manifest.version +
        "; expected " +
        supportedSdkVersion +
        ".",
    );
    hardFailure = true;
  }

  const targets = ["esm", "cjs"].map((flavor) => join(sdkRoot, ...targetRel(flavor)));
  if (!targets.some((filePath) => existsSync(filePath))) {
    console.error(
      "[apply-mcp-sdk-patch] ERROR: package-owned @modelcontextprotocol/sdk has no dist/esm or dist/cjs server/mcp.js.",
    );
    console.error(
      "[apply-mcp-sdk-patch] The SDK layout changed and the required:[] compatibility patch cannot be applied; failing so the regression is not silent.",
    );
    console.error(
      "[apply-mcp-sdk-patch] Pin @modelcontextprotocol/sdk to a known-compatible version, or update this patch script for the new layout.",
    );
    hardFailure = true;
  } else if (!hardFailure) {
    for (const filePath of targets) {
      const result = patchFile(filePath);
      if (result.status === "patched") {
        console.log("[apply-mcp-sdk-patch] patched " + result.filePath);
      } else if (result.status === "already") {
        console.log("[apply-mcp-sdk-patch] already applied " + result.filePath);
      } else if (result.status === "missing") {
        console.log("[apply-mcp-sdk-patch] skipped (flavor not present) " + result.filePath);
      } else {
        console.error(
          "[apply-mcp-sdk-patch] ERROR: pattern mismatch in " +
            result.filePath +
            " — SDK internals changed and the required:[] compatibility patch was not applied.",
        );
        console.error(
          "[apply-mcp-sdk-patch] Update the pinned SDK compatibility patch before releasing this package.",
        );
        hardFailure = true;
      }
    }
  }
  if (hardFailure) process.exitCode = 1;
}
