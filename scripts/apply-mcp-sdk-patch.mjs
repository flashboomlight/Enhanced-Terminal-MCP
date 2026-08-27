/**
 * 零依赖 postinstall：为 @modelcontextprotocol/sdk 补上 object schema 的 required: []
 * 替代 patch-package，避免将 patch-package 放进 production dependencies。
 *
 * 失败语义（fail-closed，2026-08-28 加固）：
 * - SDK 已安装但 esm/cjs 两个 server/mcp.js 都找不到 → 布局已变、补丁无法确认，报错并以退出码 1 结束，
 *   防止兼容补丁静默失效造成 outputSchema 行为回退；
 * - 目标文件存在但内部模式失配（可能上游已修复或重构）→ 显著警告，退出码 0；
 * - SDK 完全未安装（异常安装环境）→ 记录后跳过，不阻断安装。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const installRoots = [
  packageRoot,
  process.env.INIT_CWD,
  process.env.npm_config_local_prefix,
]
  .filter((value) => typeof value === "string" && value.length > 0)
  .map((value) => resolve(value))
  .filter((value, index, values) => values.indexOf(value) === index);

const sdkPackageRel = ["node_modules", "@modelcontextprotocol", "sdk"];
const targetRel = (flavor) => [...sdkPackageRel, "dist", flavor, "server", "mcp.js"];

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

  if (!changed) return { filePath, status: "noop" };
  writeFileSync(filePath, src, "utf8");
  return { filePath, status: "patched" };
}

const installedRoots = installRoots.filter((root) =>
  existsSync(join(root, ...sdkPackageRel, "package.json")),
);

if (installedRoots.length === 0) {
  console.log("[apply-mcp-sdk-patch] @modelcontextprotocol/sdk not found; nothing to patch");
} else {
  let hardFailure = false;
  for (const root of installedRoots) {
    const targets = ["esm", "cjs"].map((flavor) => join(root, ...targetRel(flavor)));
    if (!targets.some((filePath) => existsSync(filePath))) {
      console.error(
        `[apply-mcp-sdk-patch] ERROR: @modelcontextprotocol/sdk is installed under ${root} but neither dist/esm nor dist/cjs server/mcp.js exists.`,
      );
      console.error(
        "[apply-mcp-sdk-patch] The SDK layout changed and the required:[] compatibility patch cannot be applied; failing so the regression is not silent.",
      );
      console.error(
        "[apply-mcp-sdk-patch] Pin @modelcontextprotocol/sdk to a known-compatible version, or update this patch script for the new layout.",
      );
      hardFailure = true;
      continue;
    }
    for (const filePath of targets) {
      const result = patchFile(filePath);
      if (result.status === "patched") {
        console.log(`[apply-mcp-sdk-patch] patched ${result.filePath}`);
      } else if (result.status === "already") {
        console.log(`[apply-mcp-sdk-patch] already applied ${result.filePath}`);
      } else if (result.status === "missing") {
        console.log(`[apply-mcp-sdk-patch] skipped (flavor not present) ${result.filePath}`);
      } else {
        console.error(
          `[apply-mcp-sdk-patch] WARNING: pattern mismatch in ${result.filePath} — SDK internals changed or upstream already fixed it.`,
        );
        console.error(
          "[apply-mcp-sdk-patch] If MCP clients report outputSchema validation issues, update this patch script for the new SDK internals.",
        );
      }
    }
  }
  if (hardFailure) process.exitCode = 1;
}
