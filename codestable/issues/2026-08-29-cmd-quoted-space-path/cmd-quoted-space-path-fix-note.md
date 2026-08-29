---
doc_type: issue-fix
issue: 2026-08-29-cmd-quoted-space-path
status: done
created: "2026-08-29"
summary: 按方案 A 修复——cmd flavor 改 verbatim /d /s /c + 整体引号，windowsVerbatimArguments 沿五个窄化层透传；定向 103 测试 + 全量 gate 通过，引号空格路径与普通命令均验证正常
tags: [cmd, quoting, windows, spawn, verbatim-args, fix]
related: [cmd-quoted-space-path-report.md, cmd-quoted-space-path-analysis.md]
---

# cmd flavor 无法安全携带带引号的空格路径 修复记录

## 1. 修复方案

analysis 方案 A：`buildShellInvocation` 的 cmd 分支改为 **`windowsVerbatimArguments: true` + `cmd /d /s /c "<整条命令>"`**（npm/cross-spawn 同款标准形态），并把 `windowsVerbatimArguments` 沿全部窄化中间层透传到 `child_process.spawn/execFile`。

## 2. 改动清单（与 analysis 影响面一致，无范围外改动）

| 文件 | 改动 |
|---|---|
| `src/shell.ts` | `ShellInvocation` 增加可选 `windowsVerbatimArguments`；cmd 分支返回 `["/d", "/s", "/c", "\"chcp 65001 >nul && …\""]` + 标志（唯一逻辑改动点） |
| `src/stream.ts` | `spawnStream` opts 增加并转发该选项；`quickExec` 从 `inv` 读值传入 |
| `src/utils.ts` | `safeExec` 转发该选项 |
| `src/command-output.ts` | `runCommandOutput` opts 增加并转发给 `captureCommand` |
| `src/capture.ts` | `captureCommand` opts 增加并转发给 `spawnManaged` |
| `src/process-supervisor.ts` | `ManagedExecFileOptions` 增加字段；`execFileManaged` 显式解构并转发进 `execFile` options（不落入 tracking） |
| `src/tools/command.ts` | execute/batch/watch 三处 `runCommandOutput` 调用传入 `inv.windowsVerbatimArguments` |
| `src/tools/search.ts` | grep_content 的 `execFileManaged` 调用传入该选项 |
| `tests/unit/shell.test.ts` | 更新 cmd 分支构造断言（`/d /s /c` + 整体引号 + 标志）；新增 Windows 真实 spawn 回归（引号空格路径 `type` 成功 + 普通命令不受影响） |

supervisor `spawnManaged` 零改动——`ManagedSpawnOptions extends Omit<SpawnOptions,"signal">` 且 `...spawnOptions` 全量透传（analysis §1 已确认）。

## 3. 验证清单

- [x] **复现步骤验证**：report 复现脚本 `.etmcp/test-tmp/cmd-quote-issue/repro.cjs` Case A（旧形态）exit=1 的场景，修复后等价构造经 `spawnStream` 真实执行 exit=0 且输出正确（新单测 `type 带引号的空格路径文件成功输出内容`）。
- [x] **期望行为验证**：`type "D:\...\probe dir with space\probe file.txt"` 输出文件内容 `CMD-QUOTE-OK`（期望行为达成）。
- [x] **修复形态实证**（analysis 期间，repro2.cjs）：Case F（`/s /c`）、Case G（`/d /s /c` 普通命令回归）、Case H（命令链 + 引号路径）全部通过；Case D 铁证固定 Node 注入的 `\"` 改写。
- [x] **影响面回归**：定向 6 文件 103 用例全过（shell/stream/utils/platform/tools/command/tools/search——覆盖 execute/batch/watch/search/quickExec/safeExec 全部消费面）；全量 `pnpm run gate`（release 模式 11 阶段）通过。
- [x] **相关测试**：`tests/unit/shell.test.ts` cmd 构造断言已同步新形态；新增 2 个 Windows 真实 spawn 回归（非 Windows 自动 skip）。

## 4. 行为变化说明

- cmd flavor 命令行形态：`cmd /c "…"`（默认转义）→ `cmd /d /s /c "…"`（verbatim）。对无引号普通命令行为等价（Case G 实证）。
- `/d` 使 cmd 不再执行注册表 AutoRun 脚本——执行环境更可预测，与 npm 行为一致；对依赖 AutoRun 的环境是可见变化（极罕见，正向隔离）。
- 用户命令串自身引号不配对时，失败模式与交互式 cmd 一致（verbatim 后 cmd 是最终解释者）。
- pwsh/powershell/unix 三分支零改动。

## 5. 顺手发现（不在本次范围）

- `tools/search.ts` grep_content 在 cmd flavor 下传入 PowerShell 脚本文本，cmd 下本就无法执行 PS 脚本（本修复前即如此，与本 issue 不同源）——如需支持可在后续 issue 中让 grep_content 强制 PS spec 或按 flavor 分派。
- 既有 lint 9 warnings（`temp-manager.ts` 未用 `id`、`network-policy.test.ts` 未用参数）维持原状，按用户排期另行清理。

## 6. 收尾

- [x] issue 三件套（report/analysis/fix-note）齐备且 frontmatter 完整。
- [x] AGENTS.md"已知坑"中该条目更新为已修复（指向本 issue）。
- [x] scoped commit：修复代码 + 测试 + issue 三件套 + AGENTS/STATUS 回写。
