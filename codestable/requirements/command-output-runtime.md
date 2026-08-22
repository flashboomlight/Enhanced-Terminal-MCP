---
doc_type: requirement
slug: command-output-runtime
pitch: 命令执行的大输出不杀进程、按需溢写分页、原文不乱码，并保证敏感内容与容量边界可治理。
status: current
last_reviewed: 2026-08-22
implemented_by:
  - 2026-08-20-command-output-spill-paging
tags: [command-execution, paging, encoding, secret-scan, output-governance]
---

# 命令输出运行时（A+ 捕获 / 溢写 / 分页 / envelope）

## 用户故事

- 作为终端用户，我希望执行产生超大输出的命令时进程不被截断杀死，输出可完整保留并按页读取，而不是丢失尾部内容。
- 作为中文 Windows 用户，我希望 `cmd` / `powershell` / `pwsh` 三条链路的行内非 ASCII 输出一致且不乱码。
- 作为部署人员，我希望输出容量、内存保留、stderr 上限和临时盘总量都有明确的进程级配置，非法配置在 spawn 前报错。
- 作为安全负责人，我希望命中凭据的内容在落盘前被拦截，失败响应不泄露命令原文与敏感内容。

## 为什么需要

旧实现中 `execute_command` 超限返回显式截断错误，大输出只能丢弃；分页缓存是整文件文本读取，编码与性能不可控；cmd/powershell 链路中文输出乱码。命令输出是三个命令工具的核心契约，需要一个共享、可治理、可审计的运行时。

## 怎么解决

三个命令工具（`execute_command` / `batch_execute` / `watch_command`）统一走 `runCommandOutput` 编排：`capture.ts` 原始字节捕获 → 共享 secret matcher 门控 → 内存 retention（默认 1MiB 阈值）→ 超阈值 spill 到 page cache v2（`stdout.bin` / `stderr.bin` / `stdout.idx` / `meta.json`，staging 原子发布）→ finalize 组装 `CommandOutputEnvelope`。分页读取通过服务生成的 `cache_id` 走独立只读支线，不重跑命令；原失败命令翻页时保留原错误。输出编码由原始字节判定（cmd GBK、pwsh/powershell UTF-8），三链路一致。容量、内存、stderr、临时盘总量由 `MCP_COMMAND_MAX_OUTPUT_BYTES` / `MCP_COMMAND_MEMORY_OUTPUT_BYTES` / `MCP_COMMAND_MAX_STDERR_BYTES` / `MCP_TEMP_MAX_TOTAL_BYTES` 治理，非法组合在 spawn 前返回 `VALIDATION_ERROR`。

## 边界

- 小输出（≤ 内存阈值）不落盘、不产生 `cache_id`；输出超过内存阈值时自动写入分页缓存。后续通过 `cache_id` 和 `page` 读取，不会重新执行命令；`page` 不用于强制首次执行落盘。
- 秘密扫描命中时，输出正文不落盘并被抑制；strict 档返回 `SECRET_DETECTED`，其他扫描档返回不含正文的结构化结果并禁用敏感内容缓存。分页 `meta` 不保存命令、cwd 或输出正文，但命令执行审计目前仍记录命令和 cwd 元数据。
- `watch_command` 的 `duration` 是观察窗口而非超时：窗口结束 `timed_out=false`、`capture_limit_reached=true`。
- `batch_execute` 并发 1/4 动态 work queue，未调度项 `status: skipped`，计数保持稳定。
- 不改变命令 policy / SafeGuard / shell 选择优先级；Unix 仍 `/bin/sh -c`。
- legacy 文本分页目录不再生产写入，由 TTL 自然消亡；不迁移旧格式缓存。

## 变更日志

- 2026-08-22：修正分页触发条件、截断语义和秘密扫描审计边界，明确当前实现仍会在命令审计中记录 command/cwd 元数据。
