---
doc_type: decision
category: constraint
id: DEC-001
title: hardBlock 作为不可关闭的命令执行硬底线
status: active
created: 2026-07-11
related:
  - ../compound/2026-07-11-learning-safety-mode-cascades-defense.md
  - ../issues/2026-07-11-security-model-weakness/security-model-weakness-fix-note.md
tags: [security, safeguard, command-execution, defense-in-depth, safety-mode]
---

# hardBlock 作为不可关闭的命令执行硬底线

## 背景

Enhanced Terminal MCP 的安全模型分三级:`strict` / `normal` / `off`。`off` 模式设计意图是"关闭 `guardDestructiveAction` 的 Elicitation 确认弹窗,让命令免确认执行",但实现上 off 分支 `return null` 后命令类工具再无防线——`hasDangerousPattern` 正则黑名单可被变量展开/编码/find-exec/解释器绕过,而 `validatePath` 又不覆盖命令类工具。三层防线在 off 模式下级联失效,导致 `rm -rf ~/project` 这类指向用户数据的破坏性命令无阻碍执行。

详见 learning [PIT-001](2026-07-11-learning-safety-mode-cascades-defense.md) 与 issue [2026-07-11-security-model-weakness](../issues/2026-07-11-security-model-weakness/security-model-weakness-fix-note.md)。

## 结论

新增 `hardBlock(command)` 函数([src/security.ts](../../src/security.ts)),作为命令执行的第四层防线,具备以下硬约束:

1. **不可关闭**——在 `execute_command` / `batch_execute` / `watch_command` 三个命令工具的入口、所有安全模式(含 `off`)下调用,不随 `MCP_SAFETY_MODE` 级联关闭
2. **只覆盖灾难性模式**——`rm -rf /`/`~`/`$HOME`/变量指向根、`mkfs`、`dd of=/dev/`、fork bomb、`format`、关机/重启、`chmod 777 /`,共 10 条。不追求完备,只确保"明面上的灾难性命令在 off 模式不能无阻碍执行"
3. **位置**——放在 `hasDangerousPattern` 之后、`guardDestructiveAction` / rateLimit 之前,确保任何模式开关之前先过硬底线

## 为什么选这个

修复方案评估过三个方向(见 issue analysis 第 5 节):

- **方案 A(hardBlock 硬底线 + 补充黑名单)**——本决定采用。保持工具能力(仍可执行任意 shell)、补上 off 模式硬底线、不破坏现有契约
- **方案 B(off 模式直接禁用命令工具)**——安全但破坏 off 模式语义,用户设 off 就是想免确认执行命令,等于废除该能力
- **方案 C(命令白名单重设计)**——从根本上解决但改动巨大,破坏"执行任意 shell 命令"的核心能力,超 issue 范围

选 A 的核心理由:**纵深防御的各层必须独立可控**。off 模式关的是"确认弹窗"这一层,不该级联关掉"灾难性命令拦截"这层。hardBlock 作为独立防线存在,不与模式开关联动。

## 考虑过的替代方案

- **只扩充 `DANGEROUS_PATTERNS` 不加 hardBlock**:黑名单不可判定,变量展开 `X=/; rm -rf $X` 这类补不完,且 `DANGEROUS_PATTERNS` 仍只在 off/normal 生效,没解决"off 级联关闭"的结构问题
- **把 hardBlock 放进 `guardDestructiveAction` 的 off 分支**:最初 analysis 这么写,但 `guardDestructiveAction` 签名只接收 `(toolName, description)` 无 command 参数,要调 hardBlock 必须改签名影响所有调用点;且只 off 生效不如全模式生效安全。实现时改为在 command.ts 三工具内直接调(见 fix-note 第 1 节"实现调整")

## 影响

- **未来调整安全模式逻辑时**:不得移除或降级三个命令工具中的 `hardBlock` 调用。若要改 hardBlock 的调用位置或生效范围,须确认 off 模式仍有等价的不可关闭底线
- **扩展 `HARD_BLOCK_PATTERNS` 时**:新增模式须逐 issue 评估误报面——hardBlock 在所有模式下生效,误报会阻断 normal/off 模式下的合法命令。宁可漏拦灾难性边缘 case(高阶绕过),不可误拦常用命令
- **AGENTS.md 红线**:本约束属 AGENTS.md "禁止修改安全规则、路径黑名单、错误码等核心行为,除非显式授权"的覆盖范围。`HARD_BLOCK_PATTERNS` 与 `hardBlock` 函数视为安全规则核心,改动需逐 issue 显式授权
- **已知边界**:hardBlock 不追求完备。2026-07-12 已扩展解释器 system / 管道到 shell / PowerShell iex 等常见形态,但自定义编码链、多阶段载荷、未覆盖语言绑定仍可能绕过。这是应用层黑名单的固有边界,不是漏改一行代码。形式化执行隔离见 `2026-07-12-decision-command-execution-not-sandbox.md` 与 roadmap `remaining-hardening` 的 B 轨;可选收紧见 `MCP_COMMAND_POLICY=allow`
