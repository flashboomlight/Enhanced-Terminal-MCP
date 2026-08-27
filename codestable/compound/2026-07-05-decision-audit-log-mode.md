---
doc_type: decision
category: operations
date: "2026-07-05"
slug: audit-log-mode
status: active
tags: [audit, observability, performance]
description: 审计日志默认 errors 模式，只记录失败和拦截，降低正常运行时的 I/O 开销
---

# Decision: 审计日志默认 errors 模式

## 背景

审计日志可以记录所有操作（`all`），也可以只记录失败/拦截（`errors`），或完全关闭（`off`）。

## 决定

默认 `MCP_AUDIT_MODE=errors`。

## 理由

- 正常成功操作通常不需要审计回溯，失败和安全拦截才是排查重点
- `all` 模式在大量只读工具调用下会产生高频 I/O
- `errors` 模式在可观测性与性能之间取得平衡
- 需要完整审计时可通过环境变量切换到 `all`

## 影响

- 成功命令默认不写审计日志
- 安全拦截、超时、失败命令始终记录
- 审计写入失败不阻塞主流程

## 相关实现

- `src/audit.ts`
- `codestable/features/2026-07-05-audit-log/`
