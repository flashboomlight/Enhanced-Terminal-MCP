/**
 * fd-resolver.ts 单元测试 — 解析链全注入，平台中立（resolver 自身不依赖 IS_WIN）
 */

import { afterEach, describe, expect, test } from "vitest";
import { FD_PATH_ENV, type FdResolution, resetFdResolverCache, resolveFd } from "../../src/fd-resolver.js";

afterEach(() => {
  resetFdResolverCache();
});

// 常用注入：默认 PATH 无候选、探测失败（各用例按需覆盖）
function opts(over: Partial<Parameters<typeof resolveFd>[0]> = {}): Parameters<typeof resolveFd>[0] {
  return {
    env: {},
    which: async () => null,
    probeVersion: async () => null,
    ...over,
  };
}

describe("resolveFd 解析链", () => {
  test("PATH fd 命中 → available, source=path", async () => {
    const r = await resolveFd(
      opts({
        which: async (n) => (n === "fd" ? "/usr/bin/fd" : null),
        probeVersion: async () => "fd 10.2.0",
      }),
    );
    expect(r).toEqual({ available: true, source: "path", path: "/usr/bin/fd", version: "fd 10.2.0" });
  });

  test("PATH 仅 fdfind 命中（Debian/Ubuntu 包名）", async () => {
    const r = await resolveFd(
      opts({
        which: async (n) => (n === "fdfind" ? "/usr/bin/fdfind" : null),
        probeVersion: async () => "fdfind 8.7.0",
      }),
    );
    expect(r.available).toBe(true);
    if (r.available) expect(r.path).toBe("/usr/bin/fdfind");
  });

  test("全缺失 → unavailable, reason=fd_not_on_path，attempted 记录两候选", async () => {
    const r = await resolveFd(opts());
    expect(r.available).toBe(false);
    if (!r.available) {
      expect(r.diagnostic.reason).toBe("fd_not_on_path");
      expect(r.diagnostic.download_performed).toBe(false);
      expect(r.diagnostic.attempted).toHaveLength(2);
    }
  });

  test("fd 探测失败 → 继续 fdfind 候选", async () => {
    const r = await resolveFd(
      opts({
        which: async (n) => `/usr/bin/${n}`,
        probeVersion: async (f) => (f.endsWith("fdfind") ? "fdfind 8.7.0" : null),
      }),
    );
    expect(r.available).toBe(true);
    if (r.available) expect(r.path).toBe("/usr/bin/fdfind");
  });

  test("显式路径非绝对 → explicit_path_not_absolute，不触碰 PATH 候选", async () => {
    let whichCalls = 0;
    const r = await resolveFd(
      opts({
        env: { [FD_PATH_ENV]: "relative/fd" },
        which: async () => {
          whichCalls++;
          return "/usr/bin/fd";
        },
      }),
    );
    expect(r.available).toBe(false);
    if (!r.available) expect(r.diagnostic.reason).toBe("explicit_path_not_absolute");
    expect(whichCalls).toBe(0);
  });

  test("显式路径缺失 → explicit_path_missing", async () => {
    const r = await resolveFd(opts({ env: { [FD_PATH_ENV]: "/nonexistent/fd" } }));
    expect(r.available).toBe(false);
    if (!r.available) expect(r.diagnostic.reason).toBe("explicit_path_missing");
  });

  test("显式路径探测失败 → explicit_probe_failed", async () => {
    // process.execPath 是跨平台稳定存在的普通文件（非 fd）
    const r = await resolveFd(opts({ env: { [FD_PATH_ENV]: process.execPath } }));
    expect(r.available).toBe(false);
    if (!r.available) expect(r.diagnostic.reason).toBe("explicit_probe_failed");
  });

  test("进程级缓存：第二次调用不再探测；reset 后可重新解析", async () => {
    let probes = 0;
    const options = opts({
      which: async (n) => (n === "fd" ? "/usr/bin/fd" : null),
      probeVersion: async () => {
        probes++;
        return "fd 10.2.0";
      },
    });
    const [a, b] = await Promise.all([resolveFd(options), resolveFd(options)]);
    expect(a).toBe(b);
    expect(probes).toBe(1);
    resetFdResolverCache();
    const c = await resolveFd(opts());
    expect(c.available).toBe(false);
  });
});

describe("resolveFd 真实环境冒烟", () => {
  test("PATH 存在 fd/fdfind 时可解析出可运行二进制", async () => {
    const r: FdResolution = await resolveFd();
    // 本机未安装 fd 时仅断言诊断形状合规（不失败）；安装则必须可用
    if (r.available) {
      expect(r.path).toMatch(/fd(find)?$/);
      expect(r.version).toBeTruthy();
    } else {
      expect(r.diagnostic.reason).toBe("fd_not_on_path");
      expect(r.diagnostic.download_performed).toBe(false);
    }
  });
});
