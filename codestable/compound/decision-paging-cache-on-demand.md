---
name: paging-cache-on-demand
description: execute_command 默认不缓存小输出，只有显式分页请求或输出超限时才落盘
metadata:
  type: decision
status: active
updated: 2026-08-21
---

# Decision: 分页缓存按需落盘

## 背景

为 `execute_command` 添加分页支持时，需要考虑是否每次执行都把 stdout 写入临时文件。

## 决定

仅在以下情况写入分页缓存：
1. 调用方显式传了 `page` 参数
2. 输出长度超过默认/指定的 `pageSize`

否则保持原有行为，直接返回完整输出。后续翻页通过首次响应返回的 `cache_id` 读取缓存，不重新执行命令。`cache_id` 必须是服务生成的 `page-cache-{timestamp}-{random}` 形态，读取时还要确认解析路径仍在 temp root 内。

## 理由

- 小输出占绝大多数，落盘反而增加延迟和垃圾文件
- 显式 `page` 请求时才落盘，语义清晰
- 自动大输出分页避免截断信息丢失
- `cache_id` 把“执行命令”和“读取后续页”分开，避免有副作用命令被重复执行
- `cache_id` 边界校验避免把分页读取变成任意相对路径探测

## 影响

- 兼容旧调用，不指定 `page` 时输出 schema 不变
- 大输出会自动进入分页模式，调用方可能首次收到 `page` 字段
- 分页响应会返回 `cache_id`，后续读取同一输出应传 `cache_id`
- 缓存文件由 `TempManager` 自动回收
- stdout 超过 `MCP_COMMAND_MAX_OUTPUT_BYTES` 时返回明确错误，避免静默截断

> 当前代码基线仍是 `page-cache-{timestamp}-{random}` + `stdout.txt`/`stderr.txt`/`meta.json` 的 legacy 实现；A+ 的二进制索引、范围读取和统一 envelope 由 `command-output-spill-paging` feature 负责，尚未在验收前取代本决策。

## 相关实现

- `src/paging.ts`
- `src/tools/command.ts`
- `codestable/features/2026-07-05-command-output-paging/`
