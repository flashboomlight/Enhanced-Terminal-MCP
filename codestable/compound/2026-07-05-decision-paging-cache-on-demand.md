---
doc_type: decision
category: architecture
date: "2026-07-05"
slug: paging-cache-on-demand
status: superseded
superseded-by: 2026-08-22-decision-command-output-spill-paging.md
area: command-output
tags: [command-output, paging, cache]
updated: "2026-08-22"
---

**[已取代]** 见 `2026-08-22-decision-command-output-spill-paging.md`。

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

> 2026-08-21 更新：page cache v2（原始字节 + `stdout.idx` 字符索引 + staging 原子发布 + 范围读取）已随 `command-output-spill-paging` 验收落地，本决策中“显式 `page` 或超 `pageSize` 才落盘”的按需语义由新的内存阈值溢写模型（`MCP_COMMAND_MEMORY_OUTPUT_BYTES`）承载；legacy `stdout.txt` 目录不再生产写入，旧目录由 TTL 自然消亡。

## 相关实现

- `src/paging.ts`
- `src/tools/command.ts`
- `codestable/features/2026-07-05-command-output-paging/`
