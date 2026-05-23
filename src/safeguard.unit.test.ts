/**
 * safeguard.ts 纯函数单元测试
 * 不依赖 MCP Server 实例的纯逻辑部分
 */

import * as os from "os";
import { describe, expect, test } from "vitest";
import { isCriticalProcess } from "./safeguard.js";

// ====================================================================
// isCriticalProcess
// ====================================================================
describe("isCriticalProcess", () => {
  const _IS_WIN = os.platform() === "win32";

  test("空名称返回 false", () => {
    expect(isCriticalProcess(undefined)).toBe(false);
    expect(isCriticalProcess("")).toBe(false);
  });

  test("Windows 关键进程被识别", () => {
    if (_IS_WIN) {
      expect(isCriticalProcess("csrss.exe")).toBe(true);
      expect(isCriticalProcess("wininit.exe")).toBe(true);
      expect(isCriticalProcess("smss.exe")).toBe(true);
      expect(isCriticalProcess("lsass.exe")).toBe(true);
      expect(isCriticalProcess("services.exe")).toBe(true);
      expect(isCriticalProcess("svchost.exe")).toBe(true);
      expect(isCriticalProcess("dwm.exe")).toBe(true);
      expect(isCriticalProcess("explorer.exe")).toBe(true);
      expect(isCriticalProcess("winlogon.exe")).toBe(true);
      expect(isCriticalProcess("System")).toBe(true);
      expect(isCriticalProcess("System Idle Process")).toBe(true);
    }
  });

  test("Unix 关键进程被识别", () => {
    if (!_IS_WIN) {
      expect(isCriticalProcess("init")).toBe(true);
      expect(isCriticalProcess("systemd")).toBe(true);
      expect(isCriticalProcess("launchd")).toBe(true);
      expect(isCriticalProcess("kernel")).toBe(true);
      expect(isCriticalProcess("kthreadd")).toBe(true);
    }
  });

  test("普通进程不被拦截", () => {
    expect(isCriticalProcess("notepad.exe")).toBe(false);
    expect(isCriticalProcess("node")).toBe(false);
    expect(isCriticalProcess("chrome")).toBe(false);
    expect(isCriticalProcess("my-custom-app")).toBe(false);
  });

  test("大小写不敏感", () => {
    if (_IS_WIN) {
      expect(isCriticalProcess("CSRSS.EXE")).toBe(true);
      expect(isCriticalProcess("Svchost.Exe")).toBe(true);
      expect(isCriticalProcess("SYSTEM")).toBe(true);
    } else {
      expect(isCriticalProcess("INIT")).toBe(true);
      expect(isCriticalProcess("Systemd")).toBe(true);
    }
  });

  test("前后空格被 trim", () => {
    if (_IS_WIN) {
      expect(isCriticalProcess("  csrss.exe  ")).toBe(true);
    } else {
      expect(isCriticalProcess("  init  ")).toBe(true);
    }
  });

  test("pid 参数也参与保护（PID 0/1/4 为关键进程）", () => {
    expect(isCriticalProcess("notepad.exe", 1234)).toBe(false);
    expect(isCriticalProcess(undefined, 0)).toBe(true);
    expect(isCriticalProcess(undefined, 1)).toBe(true);
    expect(isCriticalProcess(undefined, 4)).toBe(true);
    if (_IS_WIN) {
      expect(isCriticalProcess("csrss.exe", 9999)).toBe(true);
    }
  });
});
