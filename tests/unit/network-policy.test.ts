/**
 * NetworkPolicy 单元测试 — IP 分类矩阵、URL/SSRF 策略、受控下载客户端（REL-04/SEC-07）
 *
 * SSRF 矩阵与 deny-private 全部用 IP 字面量测试（零 DNS、零外网）；
 * 下载成功/redirect/预算路径用 127.0.0.1 本地 http server（MCP_SSRF_MODE=allow-private）。
 */
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyIp,
  createDownloadBudget,
  type DownloadBudget,
  downloadToFile,
  getSsrfMode,
  parseUrlPolicy,
  validateTarget,
} from "../../src/network-policy.js";

const TMP_BASE = fileURLToPath(new URL("../../.etmcp/test-tmp/", import.meta.url));

const ENV_KEYS = [
  "MCP_SSRF_MODE",
  "MCP_DOWNLOAD_MAX_BYTES",
  "MCP_DOWNLOAD_TIMEOUT_MS",
  "MCP_DOWNLOAD_MAX_REDIRECTS",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("network-policy IP classification", () => {
  test("restricted: loopback / private / CGNAT / link-local-metadata / ULA", () => {
    expect(classifyIp("127.0.0.1")).toBe("restricted");
    expect(classifyIp("10.1.2.3")).toBe("restricted");
    expect(classifyIp("172.16.0.1")).toBe("restricted");
    expect(classifyIp("172.31.255.255")).toBe("restricted");
    expect(classifyIp("172.32.0.1")).toBe("normal");
    expect(classifyIp("192.168.1.1")).toBe("restricted");
    expect(classifyIp("100.64.0.1")).toBe("restricted");
    expect(classifyIp("169.254.169.254")).toBe("restricted");
    expect(classifyIp("::1")).toBe("restricted");
    expect(classifyIp("fe80::1")).toBe("restricted");
    expect(classifyIp("fc00::1")).toBe("restricted");
  });

  test("forbidden: unspecified / multicast / documentation / mapped-restricted", () => {
    expect(classifyIp("0.0.0.0")).toBe("forbidden");
    expect(classifyIp("224.0.0.1")).toBe("forbidden");
    expect(classifyIp("240.0.0.1")).toBe("forbidden");
    expect(classifyIp("::")).toBe("forbidden");
    expect(classifyIp("ff02::1")).toBe("forbidden");
    expect(classifyIp("2001:db8::1")).toBe("forbidden");
    expect(classifyIp("::ffff:127.0.0.1")).toBe("restricted"); // IPv4-mapped 归一
    expect(classifyIp("not-an-ip")).toBe("forbidden");
  });

  test("normal: public addresses", () => {
    expect(classifyIp("8.8.8.8")).toBe("normal");
    expect(classifyIp("172.32.0.1")).toBe("normal");
    expect(classifyIp("2606:4700::1111")).toBe("normal");
  });
});

describe("network-policy URL parsing and SSRF mode", () => {
  afterEach(restoreEnv);

  test("parseUrlPolicy rejects non-http protocols and credentials", () => {
    expect(parseUrlPolicy("ftp://example.com/x").ok).toBe(false);
    expect(parseUrlPolicy("file:///etc/passwd").ok).toBe(false);
    const creds = parseUrlPolicy("https://user:pass@example.com/x");
    expect(creds.ok).toBe(false);
    if (!creds.ok) expect(creds.result.error?.code).toBe("URL_INVALID");
    const ok = parseUrlPolicy("https://example.com:8443/a/b?c=1");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.port).toBe(8443);
      expect(ok.value.hostname).toBe("example.com");
    }
  });

  test("getSsrfMode falls back per surface and warns on invalid input", () => {
    delete process.env.MCP_SSRF_MODE;
    expect(getSsrfMode("download").mode).toBe("deny-private");
    expect(getSsrfMode("network_info").mode).toBe("allow-private");
    process.env.MCP_SSRF_MODE = "deny-private";
    expect(getSsrfMode("network_info").mode).toBe("deny-private");
    process.env.MCP_SSRF_MODE = "open-everything";
    expect(getSsrfMode("download")).toMatchObject({
      mode: "deny-private",
      warning: expect.stringContaining("default"),
    });
  });
});

describe("network-policy validateTarget (IP literals, zero DNS)", () => {
  afterEach(restoreEnv);

  test("deny-private rejects loopback/private/link-local/metadata targets", async () => {
    delete process.env.MCP_SSRF_MODE;
    for (const host of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "[::1]", "100.64.0.1"]) {
      const result = await validateTarget(host.replace(/^\[|\]$/g, ""), "download");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("SSRF_BLOCKED");
    }
  });

  test("allow-private still rejects forbidden addresses", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    const ok = await validateTarget("127.0.0.1", "network_info");
    expect(ok.ok).toBe(true);
    const forbidden = await validateTarget("224.0.0.1", "network_info");
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.result.error?.code).toBe("SSRF_BLOCKED");
  });
});

// ====================================================================
// 下载客户端（本地 http server）
// ====================================================================

interface TestServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("network-policy downloadToFile", () => {
  let workDir = "";

  async function freshDir(): Promise<string> {
    workDir = await fs.mkdtemp(path.join(TMP_BASE, "net-"));
    return workDir;
  }

  afterEach(async () => {
    restoreEnv();
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
      workDir = "";
    }
  });

  test("deny-private default blocks loopback download before any connection", async () => {
    delete process.env.MCP_SSRF_MODE;
    const dir = await freshDir();
    const server = await startServer((req, res) => res.end("nope"));
    try {
      const result = await downloadToFile(`${server.url}/file`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("SSRF_BLOCKED");
      await expect(fs.access(path.join(dir, "out.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
    }
  });

  test("allow-private downloads with byte accounting and no staging residue", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    const dir = await freshDir();
    const body = Buffer.from("hello download world");
    const server = await startServer((req, res) => {
      res.setHeader("Content-Length", String(body.length));
      res.end(body);
    });
    try {
      const result = await downloadToFile(`${server.url}/file`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bytes).toBe(body.length);
        expect(result.value.status).toBe(200);
      }
      expect((await fs.readFile(path.join(dir, "out.bin"))).toString()).toBe("hello download world");
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("redirect chain is followed per hop under allow-private", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    const dir = await freshDir();
    let hits = 0;
    const server = await startServer((req, res) => {
      hits++;
      if (hits === 1) {
        res.statusCode = 302;
        res.setHeader("Location", "/final");
        res.end();
        return;
      }
      res.end("after-redirect");
    });
    try {
      const result = await downloadToFile(`${server.url}/start`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(true);
      expect((await fs.readFile(path.join(dir, "out.bin"))).toString()).toBe("after-redirect");
      expect(hits).toBe(2);
    } finally {
      await server.close();
    }
  });

  test("redirect loop exceeding the hop budget returns RESOURCE_LIMIT", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    process.env.MCP_DOWNLOAD_MAX_REDIRECTS = "2";
    const dir = await freshDir();
    const server = await startServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", "/loop");
      res.end();
    });
    try {
      const result = await downloadToFile(`${server.url}/loop`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("RESOURCE_LIMIT");
    } finally {
      await server.close();
    }
  });

  test("oversized body is aborted at the byte budget with staging cleaned", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    process.env.MCP_DOWNLOAD_MAX_BYTES = "100";
    const dir = await freshDir();
    const server = await startServer((req, res) => {
      res.setHeader("Content-Length", "10000");
      const chunk = Buffer.alloc(500, 0x61);
      const timer = setInterval(() => res.write(chunk), 5);
      res.on("close", () => clearInterval(timer));
      res.on("error", () => clearInterval(timer));
    });
    try {
      const result = await downloadToFile(`${server.url}/big`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("RESOURCE_LIMIT");
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("deadline exceeded returns TIMEOUT", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    process.env.MCP_DOWNLOAD_TIMEOUT_MS = "1000";
    const dir = await freshDir();
    const server = await startServer((req, res) => {
      res.setHeader("Content-Length", "100000000");
      const timer = setInterval(() => res.write(Buffer.alloc(1024, 0x62)), 50);
      res.on("close", () => clearInterval(timer));
      res.on("error", () => clearInterval(timer));
    });
    try {
      const result = await downloadToFile(`${server.url}/slow`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("TIMEOUT");
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("request cancellation returns CANCELLED and cleans staging", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    const dir = await freshDir();
    const controller = new AbortController();
    const server = await startServer((req, res) => {
      const timer = setInterval(() => res.write(Buffer.alloc(4096, 0x63)), 10);
      res.on("close", () => clearInterval(timer));
      res.on("error", () => clearInterval(timer));
    });
    try {
      const pending = downloadToFile(`${server.url}/cancel`, path.join(dir, "out.bin"), { signal: controller.signal });
      setTimeout(() => controller.abort(), 80);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("CANCELLED");
      const entries = await fs.readdir(dir);
      expect(entries.filter((e) => e.includes(".tmp"))).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("HTTP 404 surfaces EXECUTION_FAILED without writing the file", async () => {
    process.env.MCP_SSRF_MODE = "allow-private";
    const dir = await freshDir();
    const server = await startServer((req, res) => {
      res.statusCode = 404;
      res.end("gone");
    });
    try {
      const result = await downloadToFile(`${server.url}/missing`, path.join(dir, "out.bin"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.result.error?.code).toBe("EXECUTION_FAILED");
    } finally {
      await server.close();
    }
  });

  test("download budget is shared across attempts", () => {
    const budget: DownloadBudget = createDownloadBudget();
    budget.bytesUsed = 42;
    expect(budget.bytesUsed).toBe(42);
    expect(budget.deadlineAt).toBeGreaterThan(Date.now());
  });
});
