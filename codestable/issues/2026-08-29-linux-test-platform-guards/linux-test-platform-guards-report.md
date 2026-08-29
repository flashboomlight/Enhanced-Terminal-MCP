---
doc_type: issue-report
issue: 2026-08-29-linux-test-platform-guards
status: confirmed
severity: P3
tags: [tests, platform, linux, windows-coupling, test-guards]
created: "2026-08-29"
---

# 单测套件 Windows 耦合：16 条用例在 Linux 必挂

## 现象

在 Linux VPS 上首次跑通环境后执行 `pnpm test`（847 用例），16 条单测失败，分布在 7 个文件；`pnpm run test:coverage:tools` 同族再挂 1 条（同一根因）。项目自带的跨平台验证面（platform-smoke / mcp-conformance / hostile-input / e2e-latency / safeguard）在 Linux 全部通过。

## 背景

测试套件历史上只在 Windows 跑（CI 的 ubuntu job 仅 lint/tsc；STATUS.md 记录"Linux 验证由用户自行在 VPS 处理"）。部分测试文件已有平台守卫先例（`platform.extended.test.ts` 的 `if (IS_WIN)` 分支、`shell.test.ts`/`search.test.ts` 的 skip），但以下 16 条漏网。

## 失败清单与根因（逐条核查结论：代码行为均正确，纯测试耦合）

| 文件 | 条数 | 根因 |
|---|---|---|
| `tests/unit/shell.test.ts` | 4 | pwsh bundled/显式路径解析是 Windows 概念；win32 路径在 Linux 被判为相对路径；cmd 引号断言为 win32 语义 |
| `tests/unit/upgrades-r2.test.ts` | 5 | 断言 spec.file 为 `powershell.exe`（Linux 正确返回 `zip`/`curl`）；Everything dir_path 过滤依赖 es.exe（Windows PE 二进制） |
| `tests/unit/upgrades.test.ts` | 1 | 直接 `spawn powershell.exe` |
| `tests/unit/infra.test.ts` | 3 | spawnStream 用例硬编码 `cmd.exe` |
| `tests/unit/platform.extended.test.ts` | 1 | `force 参数独立影响` 断言 args 长度不同，仅 Windows taskkill 成立（Unix `kill -15/-9` 信号恒显式，长度恒等，`src/platform.ts:87-88`） |
| `tests/unit/tools/system.test.ts` | 1 | `csrss.exe` 仅在 Windows 关键进程名单（`src/safeguard.ts:44,57`）；Linux 上正确落到确认层返回 SAFETY_BLOCKED |
| `tests/unit/state-dir.test.ts` | 1 | 用 `\\invalid\path\for\state` 当必失败路径；反斜杠在 Linux 是合法文件名字符，mkdir 成功 |

## 修复方向

按文件内既有先例补平台守卫：Windows 专属断言在非 Windows 跳过（`describe.skipIf`/`it.skipIf` 或 `if (IS_WIN)` 早返），可平台化的断言改为按平台取期望（如 force 用例在 Unix 断言信号值不同而非长度不同；state-dir 用平台相关的必失败路径）。守卫在 Windows 下直通，不改变 Windows 侧任何行为。

## 验收标准

- Linux 上 `pnpm test` 与 `pnpm run test:coverage:tools` 全绿；
- Windows 侧行为不变（守卫直通），由既有 CI Windows job 与维护者本机回归兜底；
- 不改动任何 `src/` 源码。
