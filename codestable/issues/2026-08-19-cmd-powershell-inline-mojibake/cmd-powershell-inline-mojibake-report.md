---
doc_type: issue-report
issue: 2026-08-19-cmd-powershell-inline-mojibake
status: resolved
severity: P2
resolution_date: "2026-08-21"
resolved_by: 2026-08-20-command-output-spill-paging
summary: MCP_SHELL=cmd/powershell 时行内非 ASCII 参数(如中文)输出乱码,默认 pwsh 链路正常
tags: [encoding, shell, cmd, powershell, windows]
---

# cmd/powershell 行内非 ASCII 参数乱码 Issue Report

## 1. 问题现象

Windows 下显式切换 `MCP_SHELL=cmd` 或 `MCP_SHELL=powershell` 后,`execute_command` 执行行内含非 ASCII 字符的命令(如 `echo 中文测试`),返回输出中的中文变成乱码。默认 pwsh 链路执行同一命令输出正常。

## 2. 复现步骤

1. 以 `MCP_SHELL=cmd`(或 `MCP_SHELL=powershell`)启动 MCP server;
2. 调用 `execute_command`,command 为 `echo 中文测试`;
3. 观察到:返回内容中的中文为乱码。

复现频率:稳定。

## 3. 期望 vs 实际

**期望行为**:行内非 ASCII 内容在 cmd / powershell 链路与默认 pwsh 链路表现一致,原样返回。

**实际行为**:cmd / powershell 链路下行内中文变为乱码;pwsh 链路正常。

## 4. 环境信息

- 涉及模块 / 功能:shell spec 解析与命令调用构造(`src/shell.ts` 的 cmd / powershell 分支)
- 相关文件 / 函数:`src/shell.ts` buildShellInvocation(具体行号待定,留阶段 2 确认)
- 运行环境:Windows;默认链路为 pwsh 7(不受影响),cmd / powershell 需经 `MCP_SHELL` 显式切换
- 其他上下文:在 merge 共同祖先 d430224(D/E 分叉前)上可复现同一现象——属 pre-existing 行为,非 2026-08-19 merge-e-hardening-base 合入引入

## 5. 严重程度

**P2** — 默认 pwsh 链路不受影响;cmd / powershell 仅显式切换才进入,且有绕过方式(用默认 pwsh,或把非 ASCII 内容写进脚本文件再执行)。

## 备注

- 线索(未经阶段 2 确认):与 cmd 行内参数的非 ASCII 编码解析有关;现有 `chcp 65001` preamble 只处理输出代码页,不覆盖行内参数本身的解析。
- 归口建议:可随 roadmap `merge-e-hardening-into-d` 4.6 envelope 阶段重写命令类工具 schema 时一并处理,或独立排期。

## 修复记录（2026-08-21）

M2 `command-output-spill-paging` 验收时闭环：根因确认为 cmd 管道输出原始字节为 GBK、pwsh/powershell 为 UTF-8，修复落在 `src/command-output.ts` 的 `detectOutputEncoding`（原始字节编码判定），`src/shell.ts` 的 shell 选择与 invocation 未变。三链路（cmd / powershell / pwsh）`echo 中文测试` 输出一致，验收场景 S5 通过（`tests/unit/tools/command.test.ts`「decodes Chinese output consistently across cmd, powershell, and pwsh」）。
