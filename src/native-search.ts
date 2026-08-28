/**
 * native 遍历搜索层 — search_files / grep_content 的 native fallback 实现
 * partial-result 语义：遍历/读取错误收集 warnings 并置 complete=false，不再静默吞掉（design §3.2）
 */

import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { logger } from "./logger.js";
import { pushWarning, SEARCH_BUDGET, type SearchWarning, WARNING_CODES } from "./partial-result.js";

export interface NativeSearchOutcome {
  matches: string[];
  complete: boolean;
  warnings: SearchWarning[];
}

/** 构造 AbortError（wrap 层以 name === "AbortError" 映射 CANCELLED） */
function abortError(): Error {
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  return err;
}

/** 每次循环迭代检查取消信号，中止长遍历 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** 截断命中行内容（code point 口径），超限附截断标记 */
function capMatchLine(line: string): string {
  const points = Array.from(line);
  if (points.length <= SEARCH_BUDGET.maxMatchItemChars) return line;
  return `${points.slice(0, SEARCH_BUDGET.maxMatchItemChars).join("")}…[truncated]`;
}

/** native 文件名搜索：walk root，名称匹配 nameRegex 的文件路径入 matches；readdir 失败记 warning 并继续其余分支 */
export async function nativeSearchFiles(
  root: string,
  nameRegex: RegExp,
  opts: { maxResults: number; maxDepth: number; signal?: AbortSignal },
): Promise<NativeSearchOutcome> {
  const matches: string[] = [];
  const warnings: SearchWarning[] = [];
  let complete = true;

  async function walk(p: string, depth: number): Promise<void> {
    if (depth > opts.maxDepth || matches.length >= opts.maxResults) return;
    throwIfAborted(opts.signal);
    let entries: Dirent[];
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch (e) {
      complete = false;
      pushWarning(warnings, { code: WARNING_CODES.WALK_READ_FAILED, path: p });
      logger.warn("native-search", "walk-error", `${p}: ${String(e)}`);
      return;
    }
    for (const e of entries) {
      if (matches.length >= opts.maxResults) break;
      throwIfAborted(opts.signal);
      const fp = join(p, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await walk(fp, depth + 1);
      } else if (nameRegex.test(e.name)) {
        matches.push(fp);
      }
    }
  }

  await walk(root, 0);
  return { matches, complete, warnings };
}

/** native 内容 grep：walk root 中名称匹配 fileRegex 的文件，逐行匹配 contentRegex；行内容按 maxMatchItemChars 截断 */
export async function nativeGrepContent(
  root: string,
  fileRegex: RegExp,
  contentRegex: RegExp,
  opts: { maxResults: number; maxDepth?: number; signal?: AbortSignal },
): Promise<NativeSearchOutcome> {
  const maxDepth = opts.maxDepth ?? 5;
  const matches: string[] = [];
  const warnings: SearchWarning[] = [];
  let complete = true;

  async function grepFile(fp: string): Promise<void> {
    const rl = createInterface({ input: createReadStream(fp, { encoding: "utf-8" }), crlfDelay: Infinity });
    let lineNum = 0;
    for await (const line of rl) {
      if (matches.length >= opts.maxResults) {
        rl.close();
        break;
      }
      throwIfAborted(opts.signal);
      lineNum++;
      if (contentRegex.test(line)) matches.push(`${fp}:${lineNum}: ${capMatchLine(line.trim())}`);
      contentRegex.lastIndex = 0;
    }
  }

  async function walk(p: string, depth: number): Promise<void> {
    if (depth > maxDepth || matches.length >= opts.maxResults) return;
    throwIfAborted(opts.signal);
    let entries: Dirent[];
    try {
      entries = await readdir(p, { withFileTypes: true });
    } catch (e) {
      complete = false;
      pushWarning(warnings, { code: WARNING_CODES.WALK_READ_FAILED, path: p });
      logger.warn("native-search", "walk-error", `${p}: ${String(e)}`);
      return;
    }
    for (const entry of entries) {
      if (matches.length >= opts.maxResults) break;
      throwIfAborted(opts.signal);
      const fp = join(p, entry.name);
      if (entry.isFile() && fileRegex.test(entry.name)) {
        try {
          await grepFile(fp);
        } catch (e) {
          if (e instanceof Error && e.name === "AbortError") throw e;
          complete = false;
          pushWarning(warnings, { code: WARNING_CODES.GREP_FILE_READ_FAILED, path: fp });
          logger.warn("native-search", "grep-file-error", `${fp}: ${String(e)}`);
        }
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await walk(fp, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return { matches, complete, warnings };
}
