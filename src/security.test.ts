/**
 * security.ts 单元测试
 * 覆盖所有导出函数的所有分支
 */

import * as os from "os";
import { describe, expect, test } from "vitest";
import {
  getForbiddenPaths,
  hasDangerousPattern,
  isForbiddenPath,
  isPathTraversal,
  isSensitivePath,
  normalizePath,
  sanitizeProcessName,
  validateHost,
  validatePath,
  validateUrl,
} from "./security.js";

// ====================================================================
// normalizePath
// ====================================================================
describe("normalizePath", () => {
  test("空字符串返回当前目录的绝对路径", () => {
    const result = normalizePath("");
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(1);
  });

  test("相对路径被解析为绝对路径", () => {
    const result = normalizePath("src/index.ts");
    expect(result).toContain("src");
    expect(result).toContain("index.ts");
  });

  test("已为绝对路径不变", () => {
    const absPath = os.platform() === "win32" ? "C:\\Windows\\System32" : "/usr/bin";
    const result = normalizePath(absPath);
    expect(result).toBe(absPath);
  });

  test("Windows 设备前缀 \\\\?\\ 被去除", () => {
    if (os.platform() === "win32") {
      expect(normalizePath("\\\\?\\C:\\Windows")).toBe("C:\\Windows");
      // UNC 路径去掉 \\?\ 后保留 \\server\share
      const unc = normalizePath("\\\\?\\UNC\\server\\share");
      expect(unc).toMatch(/server.+share/i);
    }
  });

  test("首尾空格被 trim", () => {
    const result = normalizePath("  /tmp/test  ");
    expect(result).not.toContain("  ");
  });
});

// ====================================================================
// isPathTraversal
// ====================================================================
describe("isPathTraversal", () => {
  test("正常路径不触发", () => {
    expect(isPathTraversal("/home/user/file.txt")).toBe(false);
    expect(isPathTraversal("src/index.ts")).toBe(false);
    expect(isPathTraversal("C:\\Users\\test")).toBe(false);
  });

  test("检测到 .. 穿越", () => {
    expect(isPathTraversal("../etc/passwd")).toBe(true);
    expect(isPathTraversal("../../etc/passwd")).toBe(true);
    expect(isPathTraversal("/var/../etc/passwd")).toBe(true);
  });

  test("检测到 URL 编码绕过 %2e%2e", () => {
    expect(isPathTraversal("%2e%2e/etc/passwd")).toBe(true);
    // %2e 是 . 的编码，%2f 是 / 的编码——两者组合也能绕过
    expect(isPathTraversal("%2e%2e%2fetc%2fpasswd")).toBe(true);
  });

  test("检测到双重 URL 编码 %252e%252e", () => {
    expect(isPathTraversal("%252e%252e/etc/passwd")).toBe(true);
  });

  test("空字符串不触发", () => {
    expect(isPathTraversal("")).toBe(false);
  });
});

// ====================================================================
// isForbiddenPath
// ====================================================================
describe("isForbiddenPath", () => {
  const _IS_WIN = os.platform() === "win32";

  test("Windows 系统目录被拦截", () => {
    if (_IS_WIN) {
      expect(isForbiddenPath("C:\\Windows\\System32\\cmd.exe")).toBe(true);
      expect(isForbiddenPath("C:\\Windows")).toBe(true);
      expect(isForbiddenPath("C:\\Program Files\\app")).toBe(true);
      expect(isForbiddenPath("C:\\Program Files (x86)\\app")).toBe(true);
      expect(isForbiddenPath("C:\\ProgramData\\config")).toBe(true);
      expect(isForbiddenPath("C:\\$Recycle.Bin\\stuff")).toBe(true);
      expect(isForbiddenPath("C:\\System Volume Information\\log")).toBe(true);
      expect(isForbiddenPath("C:\\Boot\\BCD")).toBe(true);
      // 前向斜杠路径也应拦截
      expect(isForbiddenPath("C:/Windows/System32/cmd.exe")).toBe(true);
      expect(isForbiddenPath("C:/Program Files/app")).toBe(true);
    }
  });

  test("Unix 系统目录被拦截", () => {
    if (!_IS_WIN) {
      expect(isForbiddenPath("/bin/bash")).toBe(true);
      expect(isForbiddenPath("/etc/passwd")).toBe(true);
      expect(isForbiddenPath("/proc/1/cmdline")).toBe(true);
      expect(isForbiddenPath("/sys/class/power")).toBe(true);
      expect(isForbiddenPath("/dev/null")).toBe(true);
      expect(isForbiddenPath("/boot/vmlinuz")).toBe(true);
      expect(isForbiddenPath("/usr/bin/python")).toBe(true);
      expect(isForbiddenPath("/usr/lib/libc.so")).toBe(true);
    }
  });

  test("正常用户目录不触发", () => {
    if (_IS_WIN) {
      expect(isForbiddenPath("C:\\Users\\test\\file.txt")).toBe(false);
      expect(isForbiddenPath("D:\\projects\\app")).toBe(false);
    } else {
      expect(isForbiddenPath("/home/user/file.txt")).toBe(false);
      expect(isForbiddenPath("/tmp/test")).toBe(false);
    }
  });

  test("大小写不敏感匹配 (Windows)", () => {
    if (_IS_WIN) {
      expect(isForbiddenPath("c:\\windows\\test")).toBe(true);
    }
  });
});

// ====================================================================
// isSensitivePath
// ====================================================================
describe("isSensitivePath", () => {
  const _IS_WIN = os.platform() === "win32";

  test("检测 .env 文件", () => {
    expect(isSensitivePath("/project/.env")).toBe(true);
    expect(isSensitivePath("/project/.env.production")).toBe(true);
  });

  test("检测 SSH 密钥文件", () => {
    expect(isSensitivePath("/home/user/.ssh/id_rsa")).toBe(true);
    expect(isSensitivePath("/home/user/.ssh/id_ed25519")).toBe(true);
    expect(isSensitivePath("/home/user/.ssh/id_rsa.pub")).toBe(true);
  });

  test("检测 known_hosts / authorized_keys", () => {
    expect(isSensitivePath("/home/user/.ssh/known_hosts")).toBe(true);
    expect(isSensitivePath("/home/user/.ssh/authorized_keys")).toBe(true);
  });

  test("检测证书/密钥文件", () => {
    expect(isSensitivePath("/ssl/cert.pem")).toBe(true);
    expect(isSensitivePath("/ssl/cert.pfx")).toBe(true);
    expect(isSensitivePath("/ssl/cert.p12")).toBe(true);
    expect(isSensitivePath("/ssl/server.key")).toBe(true);
    expect(isSensitivePath("/ssl/keystore.jks")).toBe(true);
  });

  test("检测 git 凭据", () => {
    expect(isSensitivePath("/home/user/.git-credentials")).toBe(true);
    expect(isSensitivePath("/home/user/.netrc")).toBe(true);
  });

  test("检测 .npmrc / .pypirc", () => {
    expect(isSensitivePath("/project/.npmrc")).toBe(true);
    expect(isSensitivePath("/project/.pypirc")).toBe(true);
  });

  test("检测系统密码文件 (Unix)", () => {
    if (!_IS_WIN) {
      expect(isSensitivePath("/etc/shadow")).toBe(true);
      expect(isSensitivePath("/etc/passwd")).toBe(true);
      expect(isSensitivePath("/etc/sudoers")).toBe(true);
    }
  });

  test("检测 kubeconfig", () => {
    expect(isSensitivePath("/home/user/kubeconfig")).toBe(true);
  });

  test("检测 .aws / .azure / .kube / .gnupg 目录 (Unix)", () => {
    if (!_IS_WIN) {
      expect(isSensitivePath("/home/user/.ssh/config")).toBe(true);
      expect(isSensitivePath("/home/user/.aws/credentials")).toBe(true);
      expect(isSensitivePath("/home/user/.azure/config")).toBe(true);
      expect(isSensitivePath("/home/user/.kube/config")).toBe(true);
      expect(isSensitivePath("/home/user/.gnupg/secring.gpg")).toBe(true);
      expect(isSensitivePath("/home/user/.config/gh/hosts.yml")).toBe(true);
      expect(isSensitivePath("/home/user/.docker/config.json")).toBe(true);
    }
  });

  test("正常文件不触发", () => {
    expect(isSensitivePath("/project/readme.md")).toBe(false);
    expect(isSensitivePath("/project/src/index.ts")).toBe(false);
    expect(isSensitivePath("/tmp/log.txt")).toBe(false);
  });
});

// ====================================================================
// validatePath
// ====================================================================
describe("validatePath", () => {
  test("正常路径返回 null（通过）", () => {
    const dir = os.platform() === "win32" ? "C:\\Users\\test" : "/home/test";
    expect(validatePath(dir, "read")).toBeNull();
  });

  test("空路径返回错误", () => {
    expect(validatePath("", "read")).toBe("Path cannot be empty");
    expect(validatePath("   ", "read")).toBe("Path cannot be empty");
  });

  test("路径穿越返回错误", () => {
    const err = validatePath("../../etc/passwd", "read");
    expect(err).toContain("traversal");
  });

  test("系统目录返回错误", () => {
    const forbidden = os.platform() === "win32" ? "C:\\Windows\\test" : "/etc/test";
    const err = validatePath(forbidden, "write");
    expect(err).toContain("blocked");
  });
});

// ====================================================================
// hasDangerousPattern
// ====================================================================
describe("hasDangerousPattern", () => {
  test("检测 rm -rf /", () => {
    expect(hasDangerousPattern("rm -rf /")).toBeTruthy();
    expect(hasDangerousPattern("rm -rf / --no-preserve-root")).toBeTruthy();
  });

  test("检测 rm -rf ~ / $HOME", () => {
    expect(hasDangerousPattern("rm -rf ~")).toBeTruthy();
    expect(hasDangerousPattern("rm -rf $HOME")).toBeTruthy();
  });

  test("检测 dd 写入磁盘", () => {
    expect(hasDangerousPattern("dd if=/dev/zero of=/dev/sda")).toBeTruthy();
    expect(hasDangerousPattern("dd if=/dev/random of=/dev/nvme0n1")).toBeTruthy();
  });

  test("检测重定向覆盖块设备", () => {
    expect(hasDangerousPattern("cat img > /dev/sda")).toBeTruthy();
  });

  test("检测 fork bomb", () => {
    expect(hasDangerousPattern(":(){ :|:& };:")).toBeTruthy();
  });

  test("检测 shutdown", () => {
    expect(hasDangerousPattern("shutdown -h now")).toBeTruthy();
    expect(hasDangerousPattern("shutdown /s /t 0")).toBeTruthy();
  });

  test("检测 chmod 777 /", () => {
    expect(hasDangerousPattern("chmod -R 777 /")).toBeTruthy();
  });

  test("检测 format", () => {
    expect(hasDangerousPattern("format C:")).toBeTruthy();
  });

  test("安全命令不触发", () => {
    expect(hasDangerousPattern("echo hello")).toBeFalsy();
    expect(hasDangerousPattern("ls -la")).toBeFalsy();
  });
});

// ====================================================================
// sanitizeProcessName
// ====================================================================
describe("sanitizeProcessName", () => {
  test("保留合法字符", () => {
    expect(sanitizeProcessName("notepad.exe")).toBe("notepad.exe");
    expect(sanitizeProcessName("my-app_v2")).toBe("my-app_v2");
  });

  test("移除特殊字符", () => {
    expect(sanitizeProcessName("notepad.exe*")).toBe("notepad.exe");
    expect(sanitizeProcessName("cmd; rm -rf /")).toBe("cmdrm-rf");
    expect(sanitizeProcessName("test&calc")).toBe("testcalc");
  });

  test("空字符串返回空", () => {
    expect(sanitizeProcessName("")).toBe("");
  });
});

// ====================================================================
// validateUrl
// ====================================================================
describe("validateUrl", () => {
  test("合法 HTTP URL 通过", () => {
    expect(validateUrl("http://example.com")).toBeNull();
    expect(validateUrl("https://example.com/path?q=1")).toBeNull();
  });

  test("空 URL 返回错误", () => {
    expect(validateUrl("")).toBe("URL cannot be empty");
  });

  test("无效 URL 返回错误", () => {
    expect(validateUrl("not-a-url")).toContain("Invalid URL");
  });

  test("非 HTTP 协议被拦截", () => {
    expect(validateUrl("file:///etc/passwd")).toContain("not allowed");
    expect(validateUrl("ftp://example.com")).toContain("not allowed");
    expect(validateUrl("javascript:alert(1)")).toContain("not allowed");
  });
});

// ====================================================================
// validateHost
// ====================================================================
describe("validateHost", () => {
  test("合法主机名通过", () => {
    expect(validateHost("localhost")).toBeNull();
    expect(validateHost("example.com")).toBeNull();
    expect(validateHost("192.168.1.1")).toBeNull();
    expect(validateHost("::1")).toBeNull();
    expect(validateHost("sub-domain.example.co.uk")).toBeNull();
  });

  test("空主机名返回错误", () => {
    expect(validateHost("")).toBe("Host cannot be empty");
  });

  test("超长主机名返回错误", () => {
    const long = "a".repeat(254);
    expect(validateHost(long)).toBe("Host too long");
  });

  test("含非法字符返回错误", () => {
    expect(validateHost("host; rm -rf")).toContain("invalid characters");
    expect(validateHost("host`id`")).toContain("invalid characters");
    expect(validateHost("host&calc")).toContain("invalid characters");
  });
});

// ====================================================================
// getForbiddenPaths
// ====================================================================
describe("getForbiddenPaths", () => {
  test("返回非空数组", () => {
    const paths = getForbiddenPaths();
    expect(paths.length).toBeGreaterThan(0);
  });

  test("Windows 返回 Windows 路径", () => {
    if (os.platform() === "win32") {
      const paths = getForbiddenPaths();
      expect(paths.some((p) => p.includes("Windows"))).toBe(true);
    }
  });

  test("Unix 返回 Unix 路径", () => {
    if (os.platform() !== "win32") {
      const paths = getForbiddenPaths();
      expect(paths.some((p) => p.startsWith("/"))).toBe(true);
    }
  });
});
