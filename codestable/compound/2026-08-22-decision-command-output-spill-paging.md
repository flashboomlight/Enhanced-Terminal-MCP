---
doc_type: decision
category: architecture
date: "2026-08-22"
slug: command-output-spill-paging
status: active
area: command-output
tags: [command-output, paging, cache, temp-manager]
supersedes: decision-paging-cache-on-demand.md
---

# Decision: 命令输出按内存阈值溢写并分页

## 背景

M2 的命令输出运行时已经替换了旧的“超过 pageSize 就落盘”的行为。当前需要保留一条明确的 active decision，避免旧的分页触发条件继续被实现或验收引用。

## 决定

- 小输出（不超过 `MCP_COMMAND_MEMORY_OUTPUT_BYTES`）直接保留在内存中，不创建 `cache_id` 或临时目录。
- 输出超过内存阈值时才自动写入 page cache v2，首次响应返回 `cache_id` 和第一页内容。
- `pageSize` 只决定分页读取的字符数，不决定是否溢写；首次执行不能通过 `page` 强制创建缓存，`page` 只用于后续 `cache_id` 读取。
- 后续分页读取只访问已发布的 `cache_id`，不会重新执行原命令。
- 输出超过捕获/保留上限时，在 envelope 中标记 `truncated` 或 `capture_limit_reached`；截断本身不是命令执行失败，非零退出、超时和终止失败仍按各自错误契约返回。
- page cache v2 使用 `stdout.bin`、`stderr.bin`、`stdout.idx` 和 `meta.json`，通过 `TempManager` 的 staging、reservation、原子发布和 TTL/LRU 回收管理生命周期。

## 理由

- 小输出不落盘可以减少延迟和临时文件数量。
- 内存阈值直接对应资源治理，比 pageSize 更适合决定是否需要持久化。
- `cache_id` 将命令执行和后续读取分开，避免有副作用的命令被重复执行。
- 原始字节和字符索引可以支持中文、GBK 以及跨页读取，不需要整文件加载。

## 后果

- 调用方不能用 `page` 请求改变首次执行的落盘策略，只能使用首次响应返回的 `cache_id` 翻页。
- page cache 的命令和 cwd 只保留在进程内上下文，不写入 `meta.json`；命令执行 audit 仍按当前工具行为记录 command/cwd 元数据。
- 旧格式的 `stdout.txt` / `stderr.txt` 缓存不迁移，由旧目录 TTL 自然清理。

## 相关文档

- `codestable/requirements/command-output-runtime.md`
- `codestable/features/2026-08-20-command-output-spill-paging/command-output-spill-paging-acceptance.md`
- `codestable/compound/decision-temp-manager-reuse.md`
