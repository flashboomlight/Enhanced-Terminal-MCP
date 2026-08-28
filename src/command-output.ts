/**
 * 命令输出共享编排层（A+ workflow）
 * 三命令工具统一入口：limits 校验 → capture 捕获 → scanner gate → retention → finalize
 * 当前落地纯内存路径 + scan-before-persist 计算节点；spill transaction / 降级 finalize 为后续步骤的可替换节点
 */
import { type CaptureStreamName, captureCommand } from "./capture.js";
import { type PageCacheEntry, type PageCacheError, PageCacheWriter, type PageResult, pageCache } from "./paging.js";
import { getSecretsScanTier, type SecretsScanTier } from "./scan.js";
import { COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES, SecretStreamMatcher } from "./secret-stream.js";
import { TempCapacityExceededError, TempLockTimeoutError } from "./temp-manager.js";

export interface CommandOutputLimits {
  /** 内存模式切换阈值（stdout+stderr retained 合计字节数） */
  memoryOutputBytes: number;
  /** stdout retained 上限 */
  maxStdoutBytes: number;
  /** stderr retained 上限 */
  maxStderrBytes: number;
  /** temp 根总容量 */
  tempMaxTotalBytes: number;
}

const DEFAULT_LIMITS: CommandOutputLimits = {
  memoryOutputBytes: 1024 * 1024,
  maxStdoutBytes: 50 * 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  tempMaxTotalBytes: 1024 * 1024 * 1024,
};

let cachedLimits: CommandOutputLimits | null = null;
let cachedLimitsError: string | null = null;

/** 解析单个字节数环境变量：未设置用默认值；非正整数/超安全整数返回错误描述 */
function parseLimitEnv(name: string, fallback: number): { value: number; error: string | null } {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return { value: fallback, error: null };
  const trimmed = raw.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { value: fallback, error: `${name} 无效: "${raw}"（需为正整数字节数）` };
  }
  return { value, error: null };
}

/**
 * 读取四个输出治理环境变量（进程级缓存，修改后需重启）。
 * 无效整数或关系不成立（memory 阈值 > stdout+stderr retained 上限合计，溢写永远不会触发）时
 * 返回 error，由调用方在 spawn 前转成 VALIDATION_ERROR，不静默回退默认值。
 */
export function getCommandOutputLimits(): { limits: CommandOutputLimits | null; error: string | null } {
  if (cachedLimits !== null || cachedLimitsError !== null) {
    return { limits: cachedLimits, error: cachedLimitsError };
  }

  const memory = parseLimitEnv("MCP_COMMAND_MEMORY_OUTPUT_BYTES", DEFAULT_LIMITS.memoryOutputBytes);
  const stdout = parseLimitEnv("MCP_COMMAND_MAX_OUTPUT_BYTES", DEFAULT_LIMITS.maxStdoutBytes);
  const stderr = parseLimitEnv("MCP_COMMAND_MAX_STDERR_BYTES", DEFAULT_LIMITS.maxStderrBytes);
  const temp = parseLimitEnv("MCP_TEMP_MAX_TOTAL_BYTES", DEFAULT_LIMITS.tempMaxTotalBytes);
  const parseError = memory.error ?? stdout.error ?? stderr.error ?? temp.error;
  if (parseError) {
    cachedLimitsError = parseError;
    return { limits: null, error: cachedLimitsError };
  }

  const limits: CommandOutputLimits = {
    memoryOutputBytes: memory.value,
    maxStdoutBytes: stdout.value,
    maxStderrBytes: stderr.value,
    tempMaxTotalBytes: temp.value,
  };
  if (limits.memoryOutputBytes > limits.maxStdoutBytes + limits.maxStderrBytes) {
    cachedLimitsError =
      `MCP_COMMAND_MEMORY_OUTPUT_BYTES (${limits.memoryOutputBytes}) 大于 stdout+stderr retained 上限合计` +
      ` (${limits.maxStdoutBytes}+${limits.maxStderrBytes})，溢写永远不会触发`;
    return { limits: null, error: cachedLimitsError };
  }

  cachedLimits = limits;
  return { limits: cachedLimits, error: null };
}

/** 清空进程级缓存（测试用） */
export function resetCommandOutputLimitsCache(): void {
  cachedLimits = null;
  cachedLimitsError = null;
}

export interface CommandOutputRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  captureLimitReached: boolean;
  terminationFailed: boolean;
  /** stdout 达到 retained 上限（等价旧 StreamResult.truncated）；secret 命中时按 stdoutActualBytes>0 计 */
  truncated: boolean;
  /** stderr 达到 retained 上限（旧行为为静默截断）；secret 命中时按 stderrActualBytes>0 计 */
  stderrTruncated: boolean;
  stdoutActualBytes: number;
  stderrActualBytes: number;
  stdoutRetainedBytes: number;
  stderrRetainedBytes: number;
  stdoutRetainedChars: number;
  /** secret 命中（全量抑制）：stdout/stderr 置空、retained 计 0、fallback 清空 */
  secretDetected: boolean;
  /** 命中时生效的扫描 tier；未命中为 null */
  secretTier: SecretsScanTier | null;
  /** scanner 已释放的每流前 65536 安全字节 fallback preview；off/write 内存阶段视全部字节安全；命中后清空 */
  stdoutFallbackPreview: Buffer;
  stderrFallbackPreview: Buffer;
  stdoutEncoding: "utf8" | "gbk";
  stderrEncoding: "utf8" | "gbk";
  paged: boolean;
  cache?: PageCacheEntry;
  cachePage?: PageResult;
  cacheDisabledReason?: "secret_detected" | "temp_capacity_exceeded" | "temp_unavailable";
  cacheError?: PageCacheError;
}

/** 单流 retained、fallback 与分页 writer 状态。 */
interface StreamState {
  chunks: Buffer[];
  retained: number;
  truncated: boolean;
  cap: number;
  fallback: Buffer[];
  fallbackBytes: number;
}

function newStreamState(cap: number): StreamState {
  return { chunks: [], retained: 0, truncated: false, cap, fallback: [], fallbackBytes: 0 };
}

/** 内存 retention：上限内保留，超限停止保留但不终止子进程。 */
function retainChunk(stream: StreamState, chunk: Buffer): void {
  if (chunk.length === 0 || stream.retained >= stream.cap) {
    if (chunk.length > 0) stream.truncated = true;
    return;
  }
  const remain = stream.cap - stream.retained;
  const slice = chunk.subarray(0, remain);
  stream.chunks.push(slice);
  stream.retained += slice.length;
  if (slice.length < chunk.length) stream.truncated = true;
}

/** 只保留 scanner 已释放的每流安全前缀，供持久化失败降级返回。 */
function feedFallback(stream: StreamState, chunk: Buffer): void {
  if (chunk.length === 0 || stream.fallbackBytes >= COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES) return;
  const remain = COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES - stream.fallbackBytes;
  const slice = chunk.subarray(0, remain);
  stream.fallback.push(slice);
  stream.fallbackBytes += slice.length;
}

/** secret 命中后的全量抑制：不保留任何此前安全前缀或 fallback。 */
function clearAllRetained(streams: Record<CaptureStreamName, StreamState>): void {
  for (const name of ["stdout", "stderr"] as const) {
    streams[name].chunks = [];
    streams[name].retained = 0;
    streams[name].fallback = [];
    streams[name].fallbackBytes = 0;
  }
}

/** 根据实际字节判定命令输出编码；Windows 对非法 UTF-8 使用 GBK。 */
function detectOutputEncoding(data: Buffer): "utf8" | "gbk" {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return "utf8";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return "utf8";
  } catch {
    return process.platform === "win32" ? "gbk" : "utf8";
  }
}

/** 返回 UTF-8 或 GBK 下一个字符单元的原始字节长度。 */
function outputUnitBytes(data: Buffer, offset: number, encoding: "utf8" | "gbk"): number {
  const first = data[offset];
  if (encoding === "gbk") {
    const second = data[offset + 1];
    return first >= 0x81 && first <= 0xfe && second >= 0x40 && second <= 0xfe && second !== 0x7f ? 2 : 1;
  }
  if (first <= 0x7f) return 1;
  if (first >= 0xc2 && first <= 0xdf) return offset + 2 <= data.length ? 2 : 1;
  if (first >= 0xe0 && first <= 0xef) return offset + 3 <= data.length ? 3 : 1;
  if (first >= 0xf0 && first <= 0xf4) return offset + 4 <= data.length ? 4 : 1;
  return 1;
}

/** 计算降级预览实际返回的原始字节数，避免把未返回尾部计入 retained。 */
function outputPrefixBytes(data: Buffer, dataStart: number, encoding: "utf8" | "gbk", maxChars: number): number {
  if (maxChars <= 0) return dataStart;
  const decoder = new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8");
  let offset = dataStart;
  let chars = 0;
  while (offset < data.length && chars < maxChars) {
    const size = outputUnitBytes(data, offset, encoding);
    const end = Math.min(data.length, offset + size);
    const decoded = decoder.decode(data.subarray(offset, end));
    chars += Math.max(1, Array.from(decoded).length);
    offset = end;
  }
  return offset;
}

/** 解码输出，并按 Unicode code point 限制降级预览长度。 */
function decodeOutput(
  data: Buffer,
  maxChars?: number,
): { text: string; encoding: "utf8" | "gbk"; returnedBytes: number } {
  const encoding = detectOutputEncoding(data);
  const dataStart =
    encoding === "utf8" && data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 3 : 0;
  const decoder = new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8");
  const text = decoder.decode(data.subarray(dataStart));
  if (maxChars === undefined) return { text, encoding, returnedBytes: data.length };
  const limited = Array.from(text).slice(0, maxChars).join("");
  return { text: limited, encoding, returnedBytes: outputPrefixBytes(data, dataStart, encoding, maxChars) };
}

/** 将 writer/缓存错误映射为公开降级原因。 */
function cacheFailure(error: unknown): {
  reason: "temp_capacity_exceeded" | "temp_unavailable";
  detail: PageCacheError;
} {
  if (error instanceof TempCapacityExceededError) {
    return {
      reason: "temp_capacity_exceeded",
      detail: {
        code: "temp_capacity_exceeded",
        message: error.message,
        retryable: true,
        detail: { cache_disabled_reason: "temp_capacity_exceeded" },
      },
    };
  }
  if (error instanceof TempLockTimeoutError) {
    return {
      reason: "temp_unavailable",
      detail: {
        code: "cache_lock_timeout",
        message: error.message,
        retryable: true,
        detail: { cache_disabled_reason: "temp_unavailable" },
      },
    };
  }
  return {
    reason: "temp_unavailable",
    detail: {
      code: "temp_unavailable",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      detail: { cache_disabled_reason: "temp_unavailable" },
    },
  };
}

/**
 * 经 capture 执行命令，按内存阈值懒创建 page cache，并保证 scanner 在 writer 之前。
 * writer/容量失败只降级为有界安全预览；capture 继续 drain，不把资源故障伪装成命令失败。
 */
export async function runCommandOutput(
  file: string,
  args: string[],
  opts: {
    timeout?: number;
    timeoutMode?: "timeout" | "watch_window";
    cwd?: string;
    env?: Record<string, string>;
    limits: CommandOutputLimits;
    pageSize?: number;
    signal?: AbortSignal;
    requestId?: string | number;
    scopeId?: string;
    kind?: string;
  },
): Promise<CommandOutputRun> {
  const streams: Record<CaptureStreamName, StreamState> = {
    stdout: newStreamState(opts.limits.maxStdoutBytes),
    stderr: newStreamState(opts.limits.maxStderrBytes),
  };
  const tier = getSecretsScanTier();
  const matchers: Record<CaptureStreamName, SecretStreamMatcher | null> = {
    stdout: tier === "cache" || tier === "strict" ? new SecretStreamMatcher() : null,
    stderr: tier === "cache" || tier === "strict" ? new SecretStreamMatcher() : null,
  };
  const pageSize = Math.max(1, Math.min(10000, Math.trunc(opts.pageSize ?? 2000)));
  let secretDetected = false;
  let spillAttempted = false;
  let spillPromise: Promise<void> | null = null;
  let writer: PageCacheWriter | null = null;
  let writerDiscard: Promise<void> | null = null;
  let cacheDisabledReason: CommandOutputRun["cacheDisabledReason"];
  let cacheError: PageCacheError | undefined;

  const markSecret = (): void => {
    if (secretDetected) return;
    secretDetected = true;
    cacheDisabledReason = "secret_detected";
    clearAllRetained(streams);
    if (writer) {
      const current = writer;
      writer = null;
      writerDiscard = current.discard().catch(() => undefined);
    }
  };

  const disableCache = async (error: unknown): Promise<void> => {
    if (secretDetected || cacheDisabledReason) return;
    const failure = cacheFailure(error);
    cacheDisabledReason = failure.reason;
    cacheError = failure.detail;
    for (const stream of ["stdout", "stderr"] as const) {
      streams[stream].chunks = [];
      streams[stream].retained = 0;
    }
    if (writer) {
      const current = writer;
      writer = null;
      await current.discard().catch(() => undefined);
    }
  };

  const writeAccepted = async (stream: CaptureStreamName, data: Buffer, addFallback = true): Promise<void> => {
    if (secretDetected || data.length === 0) return;
    const state = streams[stream];
    const accepted = data.subarray(0, Math.max(0, state.cap - state.retained));
    if (accepted.length < data.length) state.truncated = true;
    if (accepted.length === 0) return;
    if (addFallback) feedFallback(state, accepted);
    if (!writer) return;
    try {
      await writer.write(stream, accepted);
      state.retained += accepted.length;
    } catch (error) {
      await disableCache(error);
    }
  };

  const scan = async (
    stream: CaptureStreamName,
    data: Buffer,
    onSafe: (safe: Buffer) => Promise<void>,
  ): Promise<void> => {
    const matcher = matchers[stream];
    if (!matcher) {
      await onSafe(data);
      return;
    }
    const result = matcher.push(data);
    if (result.hit !== null) {
      markSecret();
      return;
    }
    if (result.released.length > 0) await onSafe(result.released);
  };

  const ensureSpill = async (): Promise<void> => {
    if (spillAttempted || writer || cacheDisabledReason) return;
    spillAttempted = true;
    const replay: Record<CaptureStreamName, Buffer[]> = { stdout: [], stderr: [] };
    if (tier === "write") {
      matchers.stdout = new SecretStreamMatcher();
      matchers.stderr = new SecretStreamMatcher();
      for (const stream of ["stdout", "stderr"] as const) {
        const raw = Buffer.concat(streams[stream].chunks);
        streams[stream].fallback = [];
        streams[stream].fallbackBytes = 0;
        const matcher = matchers[stream];
        if (!matcher) continue;
        const result = matcher.push(raw);
        if (result.hit !== null) {
          markSecret();
          return;
        }
        if (result.released.length > 0) {
          replay[stream].push(result.released);
          feedFallback(streams[stream], result.released);
        }
      }
    } else {
      replay.stdout = [...streams.stdout.chunks];
      replay.stderr = [...streams.stderr.chunks];
    }
    try {
      const nextWriter = await PageCacheWriter.create(pageSize);
      for (const stream of ["stdout", "stderr"] as const) {
        streams[stream].chunks = [];
        streams[stream].retained = 0;
      }
      writer = nextWriter;
      for (const stream of ["stdout", "stderr"] as const) {
        for (const safe of replay[stream]) await writeAccepted(stream, safe, false);
      }
    } catch (error) {
      await disableCache(error);
    }
  };

  const processSafe = async (stream: CaptureStreamName, data: Buffer): Promise<void> => {
    if (secretDetected || data.length === 0) return;
    const state = streams[stream];
    const accepted = data.subarray(0, Math.max(0, state.cap - state.retained));
    if (accepted.length < data.length) state.truncated = true;
    if (cacheDisabledReason) {
      feedFallback(state, accepted);
      return;
    }
    if (writer) {
      await writeAccepted(stream, accepted);
      return;
    }
    const memoryTotal = streams.stdout.retained + streams.stderr.retained;
    if (memoryTotal + accepted.length > opts.limits.memoryOutputBytes) {
      if (!spillPromise) {
        spillPromise = ensureSpill().finally(() => {
          spillPromise = null;
        });
      }
      await spillPromise;
      if (secretDetected) return;
      if (tier === "write" && matchers[stream]) {
        await scan(stream, data, (safe) => processSafe(stream, safe));
      } else if (writer) {
        await writeAccepted(stream, data);
      } else {
        feedFallback(state, accepted);
      }
      return;
    }
    retainChunk(state, accepted);
    feedFallback(state, accepted);
  };

  const processRaw = async (stream: CaptureStreamName, data: Buffer): Promise<void> => {
    await scan(stream, data, (safe) => processSafe(stream, safe));
  };

  const capture = await captureCommand(file, args, {
    timeout: opts.timeout,
    timeoutMode: opts.timeoutMode,
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    requestId: opts.requestId,
    scopeId: opts.scopeId,
    kind: opts.kind,
    onChunk: (stream, chunk) => processRaw(stream, chunk),
  });
  if (capture.error) throw capture.error;

  if (!secretDetected) {
    for (const stream of ["stdout", "stderr"] as const) {
      const matcher = matchers[stream];
      if (!matcher) continue;
      const result = matcher.finish();
      if (result.hit !== null) {
        markSecret();
        break;
      }
      await processSafe(stream, result.released);
    }
  }
  if (spillPromise) await spillPromise;
  if (writerDiscard) await writerDiscard;

  const stdoutTruncated = secretDetected
    ? capture.stdoutActualBytes > 0
    : capture.stdoutActualBytes > opts.limits.maxStdoutBytes || streams.stdout.truncated;
  const stderrTruncated = secretDetected
    ? capture.stderrActualBytes > 0
    : capture.stderrActualBytes > opts.limits.maxStderrBytes || streams.stderr.truncated;
  let cache: PageCacheEntry | undefined;
  let cachePage: PageResult | undefined;
  const activeWriter = writer as unknown as PageCacheWriter | null;
  if (activeWriter !== null && !secretDetected && !cacheDisabledReason) {
    const commandError: PageCacheError | undefined = capture.cancelled
      ? { code: "CANCELLED", message: "Command cancelled", retryable: true }
      : capture.timedOut
        ? { code: "TIMEOUT", message: "Command timed out", retryable: true }
        : capture.terminationFailed
          ? {
              code: "EXECUTION_FAILED",
              message: "Command termination failed",
              retryable: true,
              detail: { watch_termination_failed: true },
            }
          : capture.exitCode !== null && capture.exitCode !== 0
            ? { code: "EXECUTION_FAILED", message: `Command failed (exit ${capture.exitCode})`, retryable: true }
            : undefined;
    try {
      const published = await activeWriter.finalize({
        exitCode: capture.exitCode,
        timedOut: capture.timedOut,
        captureLimitReached: capture.captureLimitReached,
        truncated: stdoutTruncated || stderrTruncated,
        stdoutTruncated,
        stderrTruncated,
        stdoutTotalBytes: capture.stdoutActualBytes,
        stderrTotalBytes: capture.stderrActualBytes,
        error: commandError,
      });
      const firstPage = await pageCache.read(published.id, 1, pageSize);
      pageCache.remember(published);
      cache = published;
      cachePage = firstPage;
    } catch (error) {
      await disableCache(error);
    }
  }

  const stdoutBytes = secretDetected
    ? Buffer.alloc(0)
    : cachePage
      ? Buffer.from(cachePage.content)
      : cacheDisabledReason && cacheDisabledReason !== "secret_detected"
        ? Buffer.concat(streams.stdout.fallback)
        : Buffer.concat(streams.stdout.chunks);
  const stderrBytes = secretDetected
    ? Buffer.alloc(0)
    : cachePage
      ? Buffer.from(cachePage.stderr)
      : cacheDisabledReason && cacheDisabledReason !== "secret_detected"
        ? Buffer.concat(streams.stderr.fallback)
        : Buffer.concat(streams.stderr.chunks);
  const stdoutDecoded = cachePage
    ? { text: cachePage.content, encoding: cachePage.stdout_encoding, returnedBytes: cachePage.stdout_retained_bytes }
    : decodeOutput(stdoutBytes, cacheDisabledReason ? pageSize : undefined);
  const stderrDecoded = cachePage
    ? { text: cachePage.stderr, encoding: cachePage.stderr_encoding, returnedBytes: cachePage.stderr_retained_bytes }
    : decodeOutput(stderrBytes);
  const stdoutRetainedBytes = secretDetected ? 0 : (cache?.stdoutRetainedBytes ?? stdoutDecoded.returnedBytes);
  const stderrRetainedBytes = secretDetected ? 0 : (cache?.stderrRetainedBytes ?? stderrDecoded.returnedBytes);
  const finalStdoutTruncated = secretDetected
    ? capture.stdoutActualBytes > 0
    : cache
      ? cache.stdoutTruncated
      : capture.stdoutActualBytes > opts.limits.maxStdoutBytes ||
        streams.stdout.truncated ||
        capture.stdoutActualBytes > stdoutRetainedBytes;
  const finalStderrTruncated = secretDetected
    ? capture.stderrActualBytes > 0
    : cache
      ? cache.stderrTruncated
      : capture.stderrActualBytes > opts.limits.maxStderrBytes ||
        streams.stderr.truncated ||
        capture.stderrActualBytes > stderrRetainedBytes;
  const stdout = secretDetected
    ? ""
    : stdoutDecoded.text + (finalStdoutTruncated && !cachePage ? "\n... (TRUNCATED)" : "");
  return {
    stdout,
    stderr: secretDetected ? "" : stderrDecoded.text,
    exitCode: capture.exitCode,
    timedOut: capture.timedOut,
    cancelled: capture.cancelled,
    captureLimitReached: capture.captureLimitReached,
    terminationFailed: capture.terminationFailed,
    truncated: finalStdoutTruncated,
    stderrTruncated: finalStderrTruncated,
    stdoutActualBytes: capture.stdoutActualBytes,
    stderrActualBytes: capture.stderrActualBytes,
    stdoutRetainedBytes,
    stderrRetainedBytes,
    stdoutRetainedChars: secretDetected ? 0 : (cachePage?.total_chars ?? Array.from(stdoutDecoded.text).length),
    secretDetected,
    secretTier: secretDetected ? tier : null,
    stdoutFallbackPreview: secretDetected ? Buffer.alloc(0) : Buffer.concat(streams.stdout.fallback),
    stderrFallbackPreview: secretDetected ? Buffer.alloc(0) : Buffer.concat(streams.stderr.fallback),
    stdoutEncoding: secretDetected ? "utf8" : stdoutDecoded.encoding,
    stderrEncoding: secretDetected ? "utf8" : stderrDecoded.encoding,
    paged: cachePage !== undefined,
    cache,
    cachePage,
    cacheDisabledReason,
    cacheError,
  };
}
