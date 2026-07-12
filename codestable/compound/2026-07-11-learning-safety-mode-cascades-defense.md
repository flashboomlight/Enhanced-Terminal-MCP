---
doc_type: learning
track: pitfall
id: PIT-001
title: 安全模式开关级联关闭防线 —— off 模式无硬底线兜底
component: safeguard
severity: high
status: active
created: 2026-07-11
related: [../issues/2026-07-11-security-model-weakness/security-model-weakness-fix-note.md]
tags: [security, safeguard, safety-mode, defense-in-depth, command-execution]
---

# 安全模式开关级联关闭防线

## 现象

`Enhanced Terminal MCP` 的 `MCP_SAFETY_MODE=off` 设计意图是"关闭 `guardDestructiveAction` 的 Elicitation 确认弹窗,让命令免确认执行"。但实际行为是:**off 分支 `return null` 后,命令类工具再无任何防线**——`rm -rf ~/important-project` 这类指向用户数据的破坏性命令在 off 模式下畅通无阻。

## 根因

`guardDestructiveAction`([src/safeguard.ts](../../../src/safeguard.ts))的 off 分支注释写"硬性底线在 security.ts 中另外检查",但这个声称是空的:

- `security.ts` 的 `validatePath` 只在**文件类工具**(`read_file`/`write_file`/`copy_move` 等)的入口调用
- **命令类工具**(`execute_command`/`batch_execute`/`watch_command`)的入口只调 `hasDangerousPattern`(正则黑名单),根本不经过 `validatePath`
- `hasDangerousPattern` 又可被变量展开/编码/find-exec/解释器等多种方式绕过(见关联 issue 现象 1.1)

三层防线(确认弹窗 / 路径校验 / 命令黑名单)本应独立,但 off 模式把"确认弹窗"关掉后,**级联暴露了另外两层本就覆盖不全的事实**——路径校验压根不覆盖命令工具,黑名单又能绕过。注释里那个"另外检查的硬底线"是不存在的。

## 试过但没用的解法

- **扩充 `DANGEROUS_PATTERNS` 黑名单**:补了 find-exec rm、sh -c rm、python -c os.system、base64|sh,但变量展开 `X=/; rm -rf $X` 这类仍 miss。黑名单不可判定,补不完
- **让 off 模式对命令工具也走 strict(禁用)**:等于废除 off 模式对命令工具的意义,用户设 off 就是想免确认执行命令,改语义风险高

## 最终解法

新增 `hardBlock(command)` 函数([src/security.ts](../../../src/security.ts)),内含一份**不可关闭**的最低限度黑名单,只覆盖极少数真正灾难性模式(`rm -rf /`/`mkfs`/`dd of=/dev/`/fork bomb/format/关机/chmod 777 全盘)。在三个命令工具中**所有安全模式下**(含 off)调用——放在 `hasDangerousPattern` 之后、`guardDestructiveAction` 之前。

关键设计:hardBlock 不追求完备(高阶绕过仍可能),只确保"明面上的灾难性命令在 off 模式不能无阻碍执行"。它是独立于模式开关的第四层防线,不随 off 级联关闭。

## 下次怎么更早发现

任何"分级安全模式"实现,review 时盯三个信号:

1. **模式开关的语义边界是否和实现对齐**——"关闭确认" ≠ "关闭检查",off 的 off 的是什么要写清
2. **每层防线是否独立可降级**——关一层不该让另一层也失效。画一张"模式 × 防线"矩阵,确认每个格子是独立控制而非级联
3. **注释声称的"另外检查"是否真的存在**——跟着调用链走一遍,确认命令类工具的入口确实经过了声称的硬底线函数。注释和实现脱节是这类坑的典型特征

通用教训:**纵深防御的各层必须独立可控**,任何"一键全关"的开关都是设计味道——它把多层防御的独立性压扁成了一个单点。
