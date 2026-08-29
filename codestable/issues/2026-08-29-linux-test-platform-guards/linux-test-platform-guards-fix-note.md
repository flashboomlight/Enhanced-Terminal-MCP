---
doc_type: issue-fix
issue: 2026-08-29-linux-test-platform-guards
status: done
created: "2026-08-29"
summary: 按 report 修复——16 条 Windows 耦合单测补平台守卫/平台感知断言，不改任何 src 源码；Linux 上 pnpm test 与 test:coverage:tools 全绿，Windows 侧守卫直通无行为变化
tags: [tests, platform, linux, windows-coupling, fix]
---

# linux-test-platform-guards 修复记录

## 修复原则

- 一律不改 `src/`：逐条核查已确认失败均为测试耦合，代码行为正确。
- 两类手法，按用例性质选择：
  1. **Windows 语义断言**（shell 解析、PowerShell spec、cmd 引号、es.exe 输出）：`test.skipIf(!IS_WIN)` / `describe.skipIf(!IS_WIN)`，遵循各文件既有先例（`shell.test.ts` 的缓存用例、`platform.extended.test.ts` 的 taskkill 分支同款）；
  2. **机制本身跨平台**（spawnStream 捕获/截断、force 信号、关键进程保护、mkdir 失败路径）：改平台感知断言或夹具，保留 Linux 侧的机制覆盖。

## 逐文件改动

| 文件 | 改动 |
|---|---|
| `tests/unit/shell.test.ts` | 4 条加 `test.skipIf(!IS_WIN)`：bundled 拼接（posix `path.join` 无法复现 win32 路径）、显式路径×2（`path.isAbsolute` 平台语义）、cmd 引号（`wrapCommand` 的 chcp 前缀按 `IS_WIN` 条件添加，`src/shell.ts:353`）；各附一行原因注释 |
| `tests/unit/upgrades-r2.test.ts` | 新增 `IS_WIN` 导入；【性能-A】整 describe 加 `describe.skipIf(!IS_WIN)`（4 条 PowerShell spec 断言/执行；Linux 的 zip/curl spec 端到端由 e2e-latency 覆盖）；【性能-B】Everything 过滤用例加 `test.skipIf(!IS_WIN)`（`path.resolve` 归一化为 win32 语义） |
| `tests/unit/upgrades.test.ts` | 新增 `IS_WIN` 导入；【功能-4】压缩 stat 用例加 `test.skipIf(!IS_WIN)`（直接 spawn `powershell.exe`） |
| `tests/unit/infra.test.ts` | 新增 `IS_WIN` 导入；stream describe 内加 `shellCmd()` 助手，3 条 spawnStream 用例按平台选 `cmd.exe /c` 或 `/bin/sh -c`（文件顶部 spawn mock 本就放行 `/bin/sh` 真实 spawn，机制覆盖在 Linux 保留） |
| `tests/unit/platform.extended.test.ts` | `force 参数独立影响` 改平台感知：Windows 断言 args 长度不同（taskkill `/F`），Unix 断言信号值 `-15`→`-9`（`src/platform.ts:87-88` 信号恒显式、长度恒等） |
| `tests/unit/tools/system.test.ts` | 新增 `IS_WIN` 导入；`kill_process refuses critical process names` 按平台选关键进程名：Windows `csrss.exe` / Unix `init`（`src/safeguard.ts:44,57` 分平台名单） |
| `tests/unit/state-dir.test.ts` | 新增 `IS_WIN` 导入；mkdir 失败用例的必失败路径平台化：Windows 沿用 `\\invalid\path`，POSIX 改用"父组件是已存在文件"（ENOTDIR，blocker 落于既有 tmpProjectDir，afterEach 自动清理） |

## 验证

- 定向：5 个修改文件 + shell/upgrades-r2 共 7 文件单跑全过（跳过的均为新守卫的 Windows 用例）；
- `pnpm exec tsc --noEmit` ✓、`pnpm run lint` ✓（biome 自动修复 system.test.ts 一处换行格式后 0 问题）；
- 全量回归与工具层覆盖率结果见 §下回写（LINUX-VALIDATION-ISSUES.md P-09 同步关闭）。

## 风险与边界

- Windows 行为不变：所有守卫在非 Windows 才生效，Windows 侧断言逐字保留；由 CI Windows job 与维护者本机回归兜底。
- Linux 侧机制覆盖未净减：skip 掉的 7 条均为 Windows 专属语义；3 条 spawnStream 与 force/关键进程/mkdir 用例改为平台感知后在 Linux 继续真实执行。
