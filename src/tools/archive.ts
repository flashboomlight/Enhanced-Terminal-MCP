/**
 * 压缩/下载工具: compress_archive, extract_archive, download_file
 */

import * as fs from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { withRetry } from "../adaptive.js";
import { logger } from "../logger.js";
import { getCompressSpec, getDownloadSpec, getExtractSpec } from "../platform.js";
import { ErrorCode, Errors, fail, success, withErrorSchema } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { validatePath, validateRealPath, validateUrl } from "../security.js";
import { getShellSpec, shellResolutionFail } from "../shell.js";
import { safeExecFile } from "../utils.js";
import { wrapHandler } from "../wrap.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function registerArchiveTools(server: McpServer) {
  const CompressArchiveInput = z.object({
    source_path: z.string().describe("Path to file or directory to compress"),
    output_path: z.string().describe("Output zip file path"),
  });
  type CompressArchiveInput = z.infer<typeof CompressArchiveInput>;

  server.registerTool(
    "compress_archive",
    {
      title: "Compress Archive",
      description: "Compress files/directories into a zip archive.",
      inputSchema: CompressArchiveInput,
      outputSchema: withErrorSchema(
        z.object({ source: z.string(), output: z.string(), size_bytes: z.number().optional() }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("compress_archive", async ({ source_path, output_path }: CompressArchiveInput) => {
      for (const [p, l] of [
        [source_path, "source"],
        [output_path, "output"],
      ] as const) {
        const e = validatePath(p, `compress:${l}`);
        if (e) return fail(ErrorCode.PATH_FORBIDDEN, e, { retryable: false, param: l });
        const re = await validateRealPath(p, `compress:${l}`);
        if (re) return fail(ErrorCode.PATH_FORBIDDEN, re, { retryable: false, param: l });
      }

      const block = await guardDestructiveAction("compress_archive", `压缩到归档: ${source_path} -> ${output_path}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "output_path" });

      try {
        const spec = getCompressSpec(source_path, output_path, await getShellSpec());
        await safeExecFile(spec.file, spec.args, 60000);
        let size_bytes: number | undefined;
        try {
          const s = await fs.stat(output_path);
          size_bytes = s.size;
        } catch (err) {
          logger.debug("compress_archive", "stat-failed", String(err));
        }
        logger.info("compress_archive", "compressed", `${source_path} -> ${output_path}`);
        return success(`Compressed: ${source_path} -> ${output_path}${size_bytes ? ` (${size_bytes} bytes)` : ""}`, {
          source: source_path,
          output: output_path,
          size_bytes,
        });
      } catch (e: unknown) {
        return shellResolutionFail(e) ?? fail(ErrorCode.ARCHIVE_FAILED, errMsg(e), { retryable: true });
      }
    }),
  );

  const ExtractArchiveInput = z.object({
    archive_path: z.string().describe("Path to the zip file"),
    output_dir: z.string().describe("Directory to extract to"),
  });
  type ExtractArchiveInput = z.infer<typeof ExtractArchiveInput>;

  server.registerTool(
    "extract_archive",
    {
      title: "Extract Archive",
      description: "Extract a zip archive to a directory.",
      inputSchema: ExtractArchiveInput,
      outputSchema: withErrorSchema(z.object({ archive: z.string(), output: z.string() })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("extract_archive", async ({ archive_path, output_dir }: ExtractArchiveInput) => {
      for (const [p, l] of [
        [archive_path, "archive"],
        [output_dir, "output"],
      ] as const) {
        const e = validatePath(p, `extract:${l}`);
        if (e) return fail(ErrorCode.PATH_FORBIDDEN, e, { retryable: false, param: l });
        const re = await validateRealPath(p, `extract:${l}`);
        if (re) return fail(ErrorCode.PATH_FORBIDDEN, re, { retryable: false, param: l });
      }

      const block = await guardDestructiveAction("extract_archive", `解压归档: ${archive_path} -> ${output_dir}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "output_dir" });

      try {
        const spec = getExtractSpec(archive_path, output_dir, await getShellSpec());
        await safeExecFile(spec.file, spec.args, 60000);
        return success(`Extracted: ${archive_path} -> ${output_dir}`, { archive: archive_path, output: output_dir });
      } catch (e: unknown) {
        return shellResolutionFail(e) ?? fail(ErrorCode.ARCHIVE_FAILED, errMsg(e), { retryable: true });
      }
    }),
  );

  const DownloadFileInput = z.object({
    url: z.string().describe("URL to download from"),
    save_path: z.string().describe("Local path to save the file"),
  });
  type DownloadFileInput = z.infer<typeof DownloadFileInput>;

  server.registerTool(
    "download_file",
    {
      title: "Download File",
      description: "Download a file from a URL to local path (HTTP/HTTPS only).",
      inputSchema: DownloadFileInput,
      outputSchema: withErrorSchema(z.object({ url: z.string(), path: z.string() })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("download_file", async ({ url, save_path }: DownloadFileInput) => {
      const pathErr = validatePath(save_path, "download:save_path");
      if (pathErr) return fail(ErrorCode.PATH_FORBIDDEN, pathErr, { retryable: false, param: "save_path" });
      const realErr = await validateRealPath(save_path, "download:save_path");
      if (realErr) return fail(ErrorCode.PATH_FORBIDDEN, realErr, { retryable: false, param: "save_path" });
      const urlErr = validateUrl(url);
      if (urlErr) return fail(ErrorCode.URL_INVALID, urlErr, { retryable: true, param: "url" });

      const block = await guardDestructiveAction("download_file", `下载文件: ${url} -> ${save_path}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "save_path" });

      try {
        const spec = getDownloadSpec(url, save_path, await getShellSpec());
        await withRetry(() => safeExecFile(spec.file, spec.args, 120000), {
          baseDelay: 1000,
          toolName: "download_file",
        });
        return success(`Downloaded: ${url} -> ${save_path}`, { url, path: save_path });
      } catch (e: unknown) {
        return shellResolutionFail(e) ?? Errors.executionFailed(errMsg(e));
      }
    }),
  );
}
