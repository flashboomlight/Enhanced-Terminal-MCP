/**
 * 压缩/下载工具: compress_archive, extract_archive, download_file
 *
 * 硬化语义（production-hardening #7）：
 * - 路径统一走 path-policy（读/写 no-follow 语义）。
 * - download_file 走 network-policy：SSRF 校验、直连已验证 IP、逐跳 redirect 重验、
 *   字节预算与总 deadline（跨重试共享）。
 * - extract_archive 走 zip-policy：manifest 全量校验 → staging 两阶段解压（实时计数）。
 * - compress_archive 保留外部命令，spawn 前对源树做成员数/字节预算预演。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { withRetry } from "../adaptive.js";
import type { RequestContext } from "../hardening-contract.js";
import { logger } from "../logger.js";
import { createDownloadBudget, downloadToFile } from "../network-policy.js";
import { resolveForRead, resolveForWrite } from "../path-policy.js";
import { getCompressSpec } from "../platform.js";
import { ManagedProcessError } from "../process-supervisor.js";
import { ErrorCode, Errors, fail, success, type ToolResult, withErrorSchema } from "../result.js";
import { guardDestructiveAction } from "../safeguard.js";
import { getShellSpec, shellResolutionFail } from "../shell.js";
import { safeExecFile } from "../utils.js";
import { wrapHandler } from "../wrap.js";
import { extractArchive, getCompressBudgets, readManifest } from "../zip-policy.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 非瞬态下载失败（SSRF/URL/预算类）：不参与 withRetry */
class NonRetryableDownload extends Error {
  constructor(readonly result: ToolResult) {
    super("non-retryable download failure");
  }
}

/** 有界源树预演：统计文件数与总字节，超预算抛结构化错误 */
async function measureSourceTree(
  sourceReal: string,
  budgets: { maxInputBytes: number; maxMembers: number },
): Promise<{ files: number; bytes: number }> {
  const stat = await fs.stat(sourceReal);
  if (!stat.isDirectory()) {
    if (stat.size > budgets.maxInputBytes) {
      throw new Error(`Source exceeds input budget (${budgets.maxInputBytes} bytes)`);
    }
    return { files: 1, bytes: stat.size };
  }
  let files = 0;
  let bytes = 0;
  const stack: string[] = [sourceReal];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // 与压缩行为一致性由外部命令决定；预演跳过链接防拖垮
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files++;
      if (files > budgets.maxMembers) {
        throw new Error(`Source exceeds member budget (${budgets.maxMembers} entries)`);
      }
      const info = await fs.stat(full);
      bytes += info.size;
      if (bytes > budgets.maxInputBytes) {
        throw new Error(`Source exceeds input budget (${budgets.maxInputBytes} bytes)`);
      }
    }
  }
  return { files, bytes };
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
    wrapHandler(
      "compress_archive",
      async ({ source_path, output_path }: CompressArchiveInput, context: RequestContext) => {
        const srcRes = await resolveForRead(source_path, "compress:source", "source");
        if (!srcRes.ok) return srcRes.result;
        const dstRes = await resolveForWrite(output_path, "compress:output", "output");
        if (!dstRes.ok) return dstRes.result;

        const block = await guardDestructiveAction("compress_archive", `压缩到归档: ${source_path} -> ${output_path}`);
        if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "output_path" });

        try {
          // spawn 前预算预演：成员数/总字节超限直接拒绝
          await measureSourceTree(srcRes.resolution.real, getCompressBudgets());
          const spec = getCompressSpec(srcRes.resolution.real, dstRes.resolution.real, await getShellSpec());
          await safeExecFile(spec.file, spec.args, {
            timeout: 60000,
            signal: context.signal,
            requestId: context.requestId,
            scopeId: context.scopeId,
            kind: "archive-compress",
          });
          let size_bytes: number | undefined;
          try {
            const s = await fs.stat(dstRes.resolution.real);
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
          if (e instanceof ManagedProcessError && e.cancelled) return Errors.cancelled("compress_archive cancelled");
          const budgetMsg = errMsg(e);
          if (/exceeds (input|member) budget/.test(budgetMsg)) {
            return Errors.resourceLimit(`Compress source rejected: ${budgetMsg}`);
          }
          return shellResolutionFail(e) ?? fail(ErrorCode.ARCHIVE_FAILED, budgetMsg, { retryable: true });
        }
      },
    ),
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
      description: "Extract a zip archive to a directory (validated members, size budgets, staging extraction).",
      inputSchema: ExtractArchiveInput,
      outputSchema: withErrorSchema(
        z.object({
          archive: z.string(),
          output: z.string(),
          extracted: z.number().optional(),
          bytes: z.number().optional(),
        }),
      ),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler(
      "extract_archive",
      async ({ archive_path, output_dir }: ExtractArchiveInput, context: RequestContext) => {
        const arcRes = await resolveForRead(archive_path, "extract:archive", "archive_path");
        if (!arcRes.ok) return arcRes.result;
        const outRes = await resolveForWrite(output_dir, "extract:output", "output_dir");
        if (!outRes.ok) return outRes.result;
        // 目标目录不存在时 real 为"父 real + basename"，mkdir recursive 建齐（保持旧语义）
        const outputReal = outRes.resolution.real;
        try {
          await fs.mkdir(outputReal, { recursive: true });
        } catch {
          const st = await fs.stat(outputReal).catch(() => null);
          if (!st?.isDirectory()) {
            return fail(ErrorCode.VALIDATION_ERROR, "output_dir exists and is not a directory", {
              retryable: false,
              param: "output_dir",
            });
          }
        }

        const block = await guardDestructiveAction("extract_archive", `解压归档: ${archive_path} -> ${output_dir}`);
        if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "output_dir" });

        // 阶段一：manifest 全量校验（零写入）
        const manifest = await readManifest(arcRes.resolution.real);
        if (!manifest.ok) return manifest.result;
        // 阶段二：staging 解压 + 实时计数，失败自动清理
        const extracted = await extractArchive(
          manifest.value,
          arcRes.resolution.real,
          outputReal,
          undefined,
          context.signal,
        );
        if (!extracted.ok) return extracted.result;

        logger.info(
          "extract_archive",
          "extracted",
          `${archive_path} -> ${output_dir} (${extracted.value.extracted} entries)`,
        );
        return success(
          `Extracted ${extracted.value.extracted} entries (${extracted.value.bytes} bytes): ${archive_path} -> ${output_dir}`,
          {
            archive: archive_path,
            output: output_dir,
            extracted: extracted.value.extracted,
            bytes: extracted.value.bytes,
          },
        );
      },
    ),
  );

  const DownloadFileInput = z.object({
    url: z.string().max(2048).describe("URL to download from (http/https, no credentials)"),
    save_path: z.string().describe("Local path to save the file"),
  });
  type DownloadFileInput = z.infer<typeof DownloadFileInput>;

  server.registerTool(
    "download_file",
    {
      title: "Download File",
      description:
        "Download a file from an HTTP/HTTPS URL to a local path. Private/loopback/metadata targets are blocked by SSRF policy (MCP_SSRF_MODE=allow-private to allow), redirects are re-validated per hop, and size/deadline budgets apply.",
      inputSchema: DownloadFileInput,
      outputSchema: withErrorSchema(z.object({ url: z.string(), path: z.string(), size_bytes: z.number().optional() })),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    wrapHandler("download_file", async ({ url, save_path }: DownloadFileInput, context: RequestContext) => {
      const dstRes = await resolveForWrite(save_path, "download:save_path", "save_path");
      if (!dstRes.ok) return dstRes.result;
      const saveReal = dstRes.resolution.real;

      const block = await guardDestructiveAction("download_file", `下载文件: ${url} -> ${save_path}`);
      if (block) return fail(ErrorCode.SAFETY_BLOCKED, block, { retryable: false, param: "save_path" });

      // 字节预算与 deadline 跨重试共享（roadmap §5.6 契约）
      const budget = createDownloadBudget();
      let lastResult: ToolResult | null = null;
      try {
        const outcome = await withRetry(
          async () => {
            const result = await downloadToFile(url, saveReal, { signal: context.signal, budget });
            if (!result.ok) {
              lastResult = result.result;
              if (!result.result.ok) {
                if (!result.result.error.retryable) throw new NonRetryableDownload(result.result);
                throw new Error(result.result.error.message);
              }
              throw new Error("download failed");
            }
            return result.value;
          },
          { baseDelay: 1000, maxRetries: 2, toolName: "download_file" },
        );
        logger.info("download_file", "downloaded", `${url} -> ${save_path} (${outcome.bytes} bytes)`);
        return success(`Downloaded ${outcome.bytes} bytes: ${url} -> ${save_path}`, {
          url,
          path: save_path,
          size_bytes: outcome.bytes,
        });
      } catch (e: unknown) {
        if (e instanceof NonRetryableDownload) return e.result;
        if (lastResult) return lastResult;
        if (e instanceof ManagedProcessError && e.cancelled) return Errors.cancelled("download_file cancelled");
        return shellResolutionFail(e) ?? Errors.executionFailed(errMsg(e));
      }
    }),
  );
}
