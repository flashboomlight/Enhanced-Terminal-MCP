// src/tools/archive.ts — 归档下载工具：compress_archive / extract_archive / download_file
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { ok, fail, safeExecFile } from "../utils.js";
import { getCompressSpec, getExtractSpec, getDownloadSpec } from "../platform.js";
import { validatePath } from "../security.js";
import { logger } from "../logger.js";

export function registerArchiveTools(server: McpServer) {

  // ===== Tool 18: compress_archive =====
  server.registerTool(
    "compress_archive",
    {
      title: "Compress Archive",
      description: "Compress files/directories into a zip archive (PowerShell on Windows, zip on Linux/macOS)",
      inputSchema: {
        source_path: z.string().describe("Path to file or directory to compress"),
        output_path: z.string().describe("Output zip file path"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ source_path, output_path }) => {
      const srcErr = validatePath(source_path, "compress:source");
      if (srcErr) return fail(srcErr);
      const outErr = validatePath(output_path, "compress:output");
      if (outErr) return fail(outErr);
      try {
        const spec = getCompressSpec(source_path, output_path);
        await safeExecFile(spec.file, spec.args, 60000);
        logger.info("compress_archive", "compressed", `${source_path} -> ${output_path}`);
        return ok("Compressed: " + source_path + " -> " + output_path);
      } catch (e: any) {
        return fail("Compress failed: " + e.message);
      }
    }
  );

  // ===== Tool 19: extract_archive =====
  server.registerTool(
    "extract_archive",
    {
      title: "Extract Archive",
      description: "Extract a zip archive to a directory (PowerShell on Windows, unzip on Linux/macOS)",
      inputSchema: {
        archive_path: z.string().describe("Path to the zip file"),
        output_dir: z.string().describe("Directory to extract to"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ archive_path, output_dir }) => {
      const arcErr = validatePath(archive_path, "extract:archive");
      if (arcErr) return fail(arcErr);
      const outErr = validatePath(output_dir, "extract:output");
      if (outErr) return fail(outErr);
      try {
        const spec = getExtractSpec(archive_path, output_dir);
        await safeExecFile(spec.file, spec.args, 60000);
        logger.info("extract_archive", "extracted", `${archive_path} -> ${output_dir}`);
        return ok("Extracted: " + archive_path + " -> " + output_dir);
      } catch (e: any) {
        return fail("Extract failed: " + e.message);
      }
    }
  );

  // ===== Tool 20: download_file =====
  server.registerTool(
    "download_file",
    {
      title: "Download File",
      description: "Download a file from a URL to local path",
      inputSchema: {
        url: z.string().describe("URL to download from"),
        save_path: z.string().describe("Local path to save the file"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ url, save_path }) => {
      const pathErr = validatePath(save_path, "download:save_path");
      if (pathErr) return fail(pathErr);
      try {
        const dir = path.dirname(save_path);
        await fs.mkdir(dir, { recursive: true });

        const spec = getDownloadSpec(url, save_path);
        await safeExecFile(spec.file, spec.args, 120000);

        if (fsSync.existsSync(save_path)) {
          const stat = fsSync.statSync(save_path);
          logger.info("download_file", "downloaded", `${url} -> ${save_path} (${stat.size} bytes)`);
          return ok("Downloaded: " + url + "\nSaved to: " + save_path + "\nSize: " + stat.size + " bytes");
        } else {
          return fail("Download completed but file not found at: " + save_path);
        }
      } catch (e: any) {
        return fail("Download failed: " + e.message);
      }
    }
  );
}
