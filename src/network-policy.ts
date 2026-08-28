/**
 * NetworkPolicy — SSRF 校验与受控下载客户端（production-hardening 模块 F / roadmap §5.6 契约）
 *
 * - 连接绑定：DNS 解析 → 逐地址策略分类 → 用通过校验的 IP 直连（HTTPS 设 servername=hostname，
 *   SNI 与证书校验仍对域名）——DNS rebinding 窗口收敛到"解析后连接前"，连接目标已校验。
 * - redirect 逐跳重新走完整校验（解析 + SSRF），跳数有上限。
 * - 代理不支持：纯 node:http/https 不读取 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 等环境变量。
 * - 下载按实际流字节计数，字节预算与绝对 deadline 跨重试共享；所有失败路径清理 staging。
 */
import * as dns from "node:dns";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as path from "node:path";
import { ErrorCode, type ErrorCodeType, fail, type ToolResult } from "./result.js";
import { envInt } from "./utils.js";
import { VERSION } from "./version.js";

// ====================================================================
// 错误通道（与 path-policy 相同的判别联合风格）
// ====================================================================

/** 策略失败：携带已构造好的 ToolResult */
export type NetworkResult<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

function policyFail(code: ErrorCodeType, message: string, opts?: { param?: string; retryable?: boolean }): ToolResult {
  return fail(code, message, { retryable: opts?.retryable ?? false, param: opts?.param });
}

// ====================================================================
// IP 分类矩阵（唯一来源）
// ====================================================================

export type IpClass = "normal" | "restricted" | "forbidden";

function v4ToParts(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

function classifyV4(ip: string): IpClass {
  const parts = v4ToParts(ip);
  if (!parts) return "forbidden";
  const [a, b] = parts;
  if (a === 0) return "forbidden"; // 0.0.0.0/8 this-network
  if (a === 127 || a === 10) return "restricted";
  if (a === 100 && b >= 64 && b <= 127) return "restricted"; // CGNAT
  if (a === 169 && b === 254) return "restricted"; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return "restricted";
  if (a === 192 && b === 168) return "restricted";
  if (a >= 224) return "forbidden"; // multicast + reserved
  return "normal";
}

function v6ToBigInt(ip: string): bigint | null {
  // 展开含 :: 的 IPv6 为 128 位整数；非法返回 null
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): bigint[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: bigint[] = [];
    for (const group of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(BigInt(parseInt(group, 16)));
    }
    return out;
  };
  let head: bigint[] | null;
  let tail: bigint[] | null;
  if (halves.length === 2) {
    head = parseGroups(halves[0]);
    tail = parseGroups(halves[1]);
    if (head === null || tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    const zeros = Array.from({ length: fill }, () => 0n);
    head = [...head, ...zeros, ...tail];
  } else {
    head = parseGroups(halves[0]);
    if (head === null || head.length !== 8) return null;
  }
  let value = 0n;
  for (const group of head) value = (value << 16n) | group;
  return value;
}

function classifyV6(ip: string): IpClass {
  // IPv4-mapped/translated 先归一为 IPv4 判定
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::ffff:(?:0:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return classifyV4(mapped[1]);
  const value = v6ToBigInt(lower);
  if (value === null) return "forbidden";
  if (value === 0n) return "forbidden"; // ::
  if (value >> 120n === 0xffn) return "forbidden"; // ff00::/8 multicast
  if (value === 1n) return "restricted"; // ::1
  if (value >> 121n === 0x7en) return "restricted"; // fc00::/7 ULA
  if (value >> 118n === 0x3fan) return "restricted"; // fe80::/10 link-local
  if (value >> 96n === 0x20010db8n) return "forbidden"; // 2001:db8::/32 documentation
  return "normal";
}

/** 单个 IP 的安全分类（唯一判定函数） */
export function classifyIp(ip: string): IpClass {
  if (net.isIPv4(ip)) return classifyV4(ip);
  if (net.isIPv6(ip)) return classifyV6(ip);
  return "forbidden";
}

// ====================================================================
// SSRF 模式与配置
// ====================================================================

export type SsrfMode = "deny-private" | "allow-private";
export type SsrfSurface = "download" | "network_info";

/** MCP_SSRF_MODE 解析：未设置按 surface 缺省（download=deny-private、network_info=allow-private），非法值回落默认 */
export function getSsrfMode(surface: SsrfSurface): { mode: SsrfMode; warning?: string } {
  const raw = process.env.MCP_SSRF_MODE;
  const fallback: SsrfMode = surface === "download" ? "deny-private" : "allow-private";
  if (!raw || !raw.trim()) return { mode: fallback };
  const value = raw.toLowerCase().trim();
  if (value === "deny-private" || value === "allow-private") return { mode: value };
  return { mode: fallback, warning: `Unknown MCP_SSRF_MODE="${raw}", using surface default` };
}

function downloadMaxBytes(): number {
  return envInt("MCP_DOWNLOAD_MAX_BYTES", 104857600, 1);
}

function downloadTimeoutMs(): number {
  return envInt("MCP_DOWNLOAD_TIMEOUT_MS", 120000, 1000);
}

function downloadMaxRedirects(): number {
  return envInt("MCP_DOWNLOAD_MAX_REDIRECTS", 5, 0, 20);
}

// ====================================================================
// URL 解析与目标校验
// ====================================================================

export interface ParsedUrl {
  original: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  pathAndQuery: string;
}

/** URL 词法与策略解析：仅 http/https、拒绝 userinfo 凭据、hostname 非空 */
export function parseUrlPolicy(raw: string): NetworkResult<ParsedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, result: policyFail(ErrorCode.URL_INVALID, "Invalid URL", { param: "url", retryable: true }) };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      result: policyFail(ErrorCode.URL_INVALID, `URL protocol '${parsed.protocol}' not allowed (only http/https)`, {
        param: "url",
        retryable: true,
      }),
    };
  }
  if (!parsed.hostname) {
    return {
      ok: false,
      result: policyFail(ErrorCode.URL_INVALID, "URL hostname is empty", { param: "url", retryable: true }),
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      result: policyFail(ErrorCode.URL_INVALID, "URL credentials are not allowed (user:pass@host)", { param: "url" }),
    };
  }
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  const port = parsed.port ? Number(parsed.port) : defaultPort;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return {
      ok: false,
      result: policyFail(ErrorCode.URL_INVALID, "URL port is invalid", { param: "url", retryable: true }),
    };
  }
  const pathAndQuery = `${parsed.pathname}${parsed.search}` || "/";
  return {
    ok: true,
    value: { original: raw, protocol: parsed.protocol, hostname: parsed.hostname, port, pathAndQuery },
  };
}

export interface TargetResolution {
  hostname: string;
  /** 通过策略校验、允许连接的地址 */
  addresses: string[];
  policy: SsrfMode;
  /** MCP_SSRF_MODE 非法时的回落告警；由调用方记录（本模块无 logger 依赖） */
  warning?: string;
}

/**
 * 解析 hostname 并按 SSRF 策略判定。
 * IP 字面量跳过 DNS；deny-private 下任一地址命中 restricted/forbidden 即整体拒绝；
 * allow-private 下仅拒绝 forbidden，取其余地址。
 * 策略告警（非法 MCP_SSRF_MODE）经 reject 形式回传，由调用方记录后重试默认值。
 */
export async function validateTarget(hostname: string, surface: SsrfSurface): Promise<NetworkResult<TargetResolution>> {
  const { mode, warning } = getSsrfMode(surface);
  let candidates: string[];
  if (net.isIP(hostname)) {
    candidates = [hostname];
  } else {
    try {
      const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      candidates = records.map((record) => record.address);
    } catch {
      return {
        ok: false,
        result: policyFail(ErrorCode.HOST_INVALID, `Host does not resolve: ${hostname}`, {
          param: "url",
          retryable: true,
        }),
      };
    }
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      result: policyFail(ErrorCode.HOST_INVALID, `Host does not resolve: ${hostname}`, {
        param: "url",
        retryable: true,
      }),
    };
  }
  const classes = candidates.map((address) => ({ address, cls: classifyIp(address) }));
  if (mode === "deny-private") {
    const bad = classes.find((c) => c.cls !== "normal");
    if (bad) {
      return {
        ok: false,
        result: policyFail(
          ErrorCode.SSRF_BLOCKED,
          `Network target blocked by SSRF policy (deny-private): ${bad.cls === "forbidden" ? "forbidden" : "private/link-local"} address`,
          { param: "url" },
        ),
      };
    }
    return { ok: true, value: { hostname, addresses: candidates, policy: mode, warning } };
  }
  const passing = classes.filter((c) => c.cls !== "forbidden").map((c) => c.address);
  if (passing.length === 0) {
    return {
      ok: false,
      result: policyFail(ErrorCode.SSRF_BLOCKED, "Network target blocked by SSRF policy: forbidden address", {
        param: "url",
      }),
    };
  }
  return { ok: true, value: { hostname, addresses: passing, policy: mode, warning } };
}

// ====================================================================
// 下载客户端
// ====================================================================

export interface DownloadBudget {
  /** 跨重试共享的实际接收字节累计 */
  bytesUsed: number;
  /** 跨重试共享的绝对 deadline（epoch ms） */
  deadlineAt: number;
}

export function createDownloadBudget(): DownloadBudget {
  return { bytesUsed: 0, deadlineAt: Date.now() + downloadTimeoutMs() };
}

export interface DownloadOutcome {
  bytes: number;
  finalUrl: string;
  status: number;
}

interface DownloadOptions {
  signal?: AbortSignal;
  /** 跨重试共享的预算；未提供时新建 */
  budget?: DownloadBudget;
}

class DownloadAbort extends Error {
  readonly code: ErrorCodeType;
  constructor(code: ErrorCodeType, message: string) {
    super(message);
    this.code = code;
  }
}

async function cleanupStaging(staging: string): Promise<void> {
  await fs.rm(staging, { force: true }).catch(() => {});
}

function mapDownloadError(e: unknown): ToolResult {
  if (e instanceof DownloadAbort) {
    return fail(e.code, e.message, {
      retryable: e.code === ErrorCode.TIMEOUT || e.code === ErrorCode.RESOURCE_LIMIT,
      param: "url",
    });
  }
  const message = e instanceof Error ? e.message : String(e);
  return fail(ErrorCode.EXECUTION_FAILED, `Download failed: ${message}`, { retryable: true, param: "url" });
}

/**
 * 受控下载：parse → SSRF 校验 → 直连已验证 IP → 手动 redirect 重验 →
 * 流式 staging + 实际字节计数（预算跨重试共享）→ 原子 rename 落位。
 */
export async function downloadToFile(
  rawUrl: string,
  saveReal: string,
  opts: DownloadOptions = {},
): Promise<NetworkResult<DownloadOutcome>> {
  const budget = opts.budget ?? createDownloadBudget();
  const maxBytes = downloadMaxBytes();
  const maxRedirects = downloadMaxRedirects();
  const parentDir = path.dirname(saveReal);
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = parseUrlPolicy(currentUrl);
    if (!parsed.ok) return parsed;
    const url = parsed.value;
    if (Date.now() > budget.deadlineAt) {
      return {
        ok: false,
        result: policyFail(ErrorCode.TIMEOUT, `Download deadline exceeded after ${budget.bytesUsed} bytes`, {
          retryable: true,
        }),
      };
    }

    const target = await validateTarget(url.hostname, "download");
    if (!target.ok) return target;
    const address = target.value.addresses[0];

    const staging = path.join(
      parentDir,
      `.${path.basename(saveReal)}.download-${process.pid}-${Date.now()}-${hop}.tmp`,
    );
    const attempt = await requestOnce({ url, address, staging, budget, maxBytes, signal: opts.signal });
    if (!attempt.ok) return attempt;

    if (attempt.value.kind === "redirect") {
      if (hop === maxRedirects) {
        return {
          ok: false,
          result: policyFail(ErrorCode.RESOURCE_LIMIT, `Download exceeded ${maxRedirects} redirects`, {
            retryable: true,
          }),
        };
      }
      currentUrl = attempt.value.location;
      continue;
    }

    try {
      await fs.rename(staging, saveReal);
    } catch (e) {
      await cleanupStaging(staging);
      return { ok: false, result: mapDownloadError(e) };
    }
    return { ok: true, value: { bytes: attempt.value.bytes, finalUrl: currentUrl, status: attempt.value.status } };
  }
  return {
    ok: false,
    result: policyFail(ErrorCode.RESOURCE_LIMIT, `Download exceeded ${maxRedirects} redirects`, { retryable: true }),
  };
}

type AttemptResult = NetworkResult<
  { kind: "redirect"; location: string } | { kind: "body"; status: number; bytes: number; staging: string }
>;

interface RequestArgs {
  url: ParsedUrl;
  address: string;
  staging: string;
  budget: DownloadBudget;
  maxBytes: number;
  signal?: AbortSignal;
}

async function requestOnce(args: RequestArgs): Promise<AttemptResult> {
  const { url, address, staging, budget, maxBytes, signal } = args;
  const module: typeof http | typeof https = url.protocol === "https:" ? https : http;
  const remaining = Math.max(budget.deadlineAt - Date.now(), 1000);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const hostHeader = url.port === defaultPort ? url.hostname : `${url.hostname}:${url.port}`;

  let onAbort: (() => void) | null = null;
  if (signal) {
    onAbort = () => req.destroy(new DownloadAbort(ErrorCode.CANCELLED, "Download cancelled"));
  }
  const req = module.request({
    host: address,
    port: url.port,
    path: url.pathAndQuery,
    method: "GET",
    servername: url.protocol === "https:" ? url.hostname : undefined,
    headers: {
      host: hostHeader,
      "user-agent": `enhanced-terminal-mcp/${VERSION}`,
      accept: "*/*",
    },
    timeout: remaining,
  });
  if (signal && onAbort) {
    if (signal.aborted) {
      req.destroy();
      return { ok: false, result: fail(ErrorCode.CANCELLED, "Download cancelled", { retryable: true, param: "url" }) };
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return await new Promise<AttemptResult>((resolve) => {
    let responseStarted = false;
    const settle = (result: AttemptResult): void => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    req.on("timeout", () => {
      req.destroy(new DownloadAbort(ErrorCode.TIMEOUT, "Download timed out"));
    });
    req.on("error", (e) => {
      // 流式阶段（responseStarted）的错误由 handleResponse 清理后统一返回
      if (!responseStarted) settle({ ok: false, result: mapDownloadError(e) });
    });
    req.end();
    req.on("response", (res) => {
      responseStarted = true;
      handleResponse(res, args)
        .then((result) => settle(result))
        .catch((e) => settle({ ok: false, result: mapDownloadError(e) }));
    });
  });
}

async function handleResponse(res: http.IncomingMessage, args: RequestArgs): Promise<AttemptResult> {
  const { url, staging, budget, maxBytes, signal } = args;
  const status = res.statusCode ?? 0;
  try {
    if (status >= 300 && status < 400) {
      const location = res.headers.location;
      res.resume(); // 丢弃重定向响应体
      if (!location) {
        return {
          ok: false,
          result: policyFail(ErrorCode.EXECUTION_FAILED, `Download failed: HTTP ${status} without Location`, {
            retryable: true,
          }),
        };
      }
      let resolved: URL;
      try {
        resolved = new URL(location, url.original);
      } catch {
        return {
          ok: false,
          result: policyFail(ErrorCode.URL_INVALID, "Redirect Location is not a valid URL", {
            param: "url",
            retryable: true,
          }),
        };
      }
      return { ok: true, value: { kind: "redirect", location: resolved.toString() } };
    }
    if (status >= 400) {
      res.resume();
      return {
        ok: false,
        result: policyFail(ErrorCode.EXECUTION_FAILED, `Download failed: HTTP ${status}`, { retryable: true }),
      };
    }
    return await streamToStaging(res, staging, budget, maxBytes, signal);
  } finally {
    res.destroy();
  }
}

async function streamToStaging(
  res: http.IncomingMessage,
  staging: string,
  budget: DownloadBudget,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<AttemptResult> {
  let handle: fs.FileHandle | null = null;
  let bytes = 0;
  try {
    handle = await fs.open(staging, "wx", 0o600);
    for await (const chunk of res) {
      if (signal?.aborted) throw new DownloadAbort(ErrorCode.CANCELLED, "Download cancelled");
      if (Date.now() > budget.deadlineAt) {
        throw new DownloadAbort(
          ErrorCode.TIMEOUT,
          `Download deadline exceeded after ${budget.bytesUsed + bytes} bytes`,
        );
      }
      bytes += chunk.length;
      if (budget.bytesUsed + bytes > maxBytes) {
        throw new DownloadAbort(ErrorCode.RESOURCE_LIMIT, `Download exceeded byte budget (${maxBytes} bytes)`);
      }
      await handle.write(chunk);
    }
    await handle.close();
    handle = null;
    budget.bytesUsed += bytes;
    return { ok: true, value: { kind: "body", status: res.statusCode ?? 0, bytes, staging } };
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    await cleanupStaging(staging);
    // 字节已耗尽的失败也计入共享预算，重试无法绕过
    budget.bytesUsed += bytes;
    // req.destroy 传递的错误对象在 res 流上可能退化为 ECONNRESET，按取消/deadline 状态优先判定
    if (signal?.aborted) {
      return { ok: false, result: mapDownloadError(new DownloadAbort(ErrorCode.CANCELLED, "Download cancelled")) };
    }
    if (Date.now() > budget.deadlineAt) {
      return {
        ok: false,
        result: mapDownloadError(
          new DownloadAbort(ErrorCode.TIMEOUT, `Download deadline exceeded after ${budget.bytesUsed} bytes`),
        ),
      };
    }
    return { ok: false, result: mapDownloadError(e) };
  }
}
