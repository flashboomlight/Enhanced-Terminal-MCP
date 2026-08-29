---
doc_type: issue-report
issue: 2026-08-29-cmd-quoted-space-path
status: confirmed
severity: P2
summary: MCP_SHELL=cmd 兼容档下，命令串携带带引号的空格路径必然执行失败（"文件名、目录名或卷标语法不正确"），同命令在交互式 cmd 与 verbatim /d /s /c 形态下均正常
tags: [cmd, quoting, windows, shell-invocation, spawn]
created: "2026-08-29"
---

# cmd flavor 无法安全携带带引号的空格路径 Issue Report

## 1. 问题现象

`MCP_SHELL=cmd`（兼容档）下，通过 `execute_command` 执行**命令串中含带引号空格路径**的命令时执行失败，cmd 报 `文件名、目录名或卷标语法不正确。`（ERROR 名称），或路径被静默截断/引号错位。同一命令串：

- 在交互式 cmd 窗口手工执行 → 成功；
- 在默认 pwsh 7 档下执行 → 成功（pwsh 分支不受影响）；
- 以 `windowsVerbatimArguments + cmd /d /s /c "<整体命令>"` 形态 spawn → 成功。

复现脚本（项目内，只读探测）：`.etmcp/test-tmp/cmd-quote-issue/repro.cjs`，实测输出：

```text
=== Case A: server-equivalent  ["/c", command] (Node default escaping) ===
exitCode: 1 | stdout: "" | stderr: "文件名、目录名或卷标语法不正确。\r\n"
=== Case B: verbatim ["/d","/s","/c", quoted] (reference) ===
exitCode: 0 | stdout: "CMD-QUOTE-PROBE-OK"
=== Case C: plain command via server-equivalent form ===
exitCode: 0 | stdout: "PLAIN-OK\r\n"
```

其中 Case A 与服务端 `buildShellInvocation` 的 cmd 分支产物完全一致（`spawn("cmd.exe", ["/c", "chcp 65001 >nul && type \"<含空格路径>\""])`）。

## 2. 复现步骤

1. 准备含空格路径文件，如 `D:\ALL MCP\Enhanced Terminal MCP\.etmcp\test-tmp\cmd-quote-issue\probe dir with space\probe file.txt`（内容任意）。
2. 运行 `node .etmcp/test-tmp/cmd-quote-issue/repro.cjs`（或：设 `MCP_SHELL=cmd` 后通过 execute_command 执行 `type "<上述路径>"`）。
3. 观察到：Case A 退出码 1、stderr 为"文件名、目录名或卷标语法不正确"；Case B 同命令成功输出文件内容；Case C 证明无引号普通命令不受影响。

复现频率：**稳定（100%）**，凡命令串携带带引号空格路径必现。

## 3. 期望 vs 实际

**期望行为**：命令串里的引号按 cmd 语法原样传给 cmd.exe 解析，`type "D:\...\probe file.txt"` 正确定位文件并输出内容。

**实际行为**：spawn 链路把参数交给 Node 默认的 Windows argv 转义后，cmd 收到的命令行中引号已被改写（内嵌引号呈现为 `\"` 序列、参数被重新包裹），cmd 的 `/c` 引号剥除逻辑与该形态冲突，路径解析错位导致执行失败。

## 4. 环境信息

- 涉及模块 / 功能：命令执行链的 shell 调用构造（cmd 兼容档）；pwsh/powershell/unix 分支不受影响。
- 相关文件 / 函数：`src/shell.ts` 的 `buildShellInvocation`（cmd 分支构造 `["/c", wrapCommand(command)]`）与 `src/stream.ts` 的 `spawnStream`（经 `process-supervisor` 最终落到 `child_process.spawn`）；`spawnManaged` 的 options 透传面在分析阶段确认。
- 运行环境：Windows（本项目开发机 win32）+ Node.js ≥20；仅在 `MCP_SHELL=cmd` 或 cmd flavor 被回退选中时触发。
- 其他上下文：2026-08-28 重构（`E:/Codex_Temp` → `.etmcp/test-tmp` 迁移）时首次发现，当时以 `cwd` 参数 + 纯 basename 命令规避并记入 AGENTS.md 已知坑，明确"修改 spawnStream/shell 构造属执行核心，须另立 issue"——本 issue 即该欠账。

## 5. 严重程度

**P2** — 非默认配置（默认 pwsh 7 不受影响），存在已文档化的绕过方法（`cwd` + basename），但触发时是难懂的执行失败且错误信息误导；用户已明确将其列为修复优先项（发布前清账，避免发布后维护）。

## 备注

- 根因推测（供阶段 2 验证，不作结论）：Node `spawn` 默认按 MS CRT 规则拼接 Windows 命令行（参数重包裹 + 内嵌引号转义为 `\"`），而 `cmd.exe` 不按 CRT 规则解引号，`/c` 的引号剥除逻辑（`/S` 语义差异更甚）与该形态冲突。Case A/B/C 的对照证据已固定。
- 排除项：`2026-08-19-cmd-powershell-inline-mojibake`（编码问题，已修复）与本问题（引号/路径解析）不同源。
- 流程说明：按 `CS-AUTOMATION.md` 授权，本报告的阶段确认（用户 checkpoint）由 agent 代行；report 内容已经对照复现证据核实，`status: confirmed`。
