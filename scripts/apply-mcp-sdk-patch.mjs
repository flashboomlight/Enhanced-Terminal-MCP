/**
 * 零依赖 postinstall：为 @modelcontextprotocol/sdk 补上 object schema 的 required: []
 * 替代 patch-package，避免将 patch-package 放进 production dependencies。
 * 若 SDK 已含补丁或包不存在则静默跳过。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "mcp.js"),
  join(root, "node_modules", "@modelcontextprotocol", "sdk", "dist", "cjs", "server", "mcp.js"),
];

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

const results = targets.map(patchFile);
for (const r of results) {
  if (r.status === "patched") {
    console.log(`[apply-mcp-sdk-patch] patched ${r.filePath}`);
  } else if (r.status === "already") {
    console.log(`[apply-mcp-sdk-patch] already applied ${r.filePath}`);
  } else if (r.status === "missing") {
    // optional dep not installed — fine
  } else {
    console.log(`[apply-mcp-sdk-patch] skipped (pattern mismatch) ${r.filePath}`);
  }
}
