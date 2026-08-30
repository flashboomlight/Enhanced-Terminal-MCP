# 排错

[English](./troubleshooting.md)

> 本文为英文 `troubleshooting.md` 的中文翻译版；如有出入，以英文版为准。

每条按"现象 → 原因 → 处置"组织。都不匹配时，设置 `MCP_LOG_LEVEL=debug` 重启服务，先查客户端的 MCP 日志与审计日志（见下），再提 issue。

## 装了 pwsh 但服务仍用 PowerShell 5.1

**原因：** Windows shell 解析链（`MCP_POWERSHELL_PATH` → 捆绑 `tools/pwsh` → `PATH` → 5.1 回退）按进程生命周期缓存。

**处置：** 安装 pwsh 或修改 `MCP_SHELL` / `MCP_POWERSHELL_PATH` 之后，重启 MCP 服务（重启客户端或其中的 MCP 服务条目）。

## `everything_search` 提示 Everything 不可用 / Windows 上 `search_files` 慢

**原因：** Everything **不随本包分发**——应用本体和 `es.exe` CLI 都不包含。

**处置：** 从 voidtools 安装 Everything，然后通过 `ENHANCED_TERMINAL_ES_PATH`（绝对路径）把服务指向 `es.exe`，或把文件放到 `<state-dir>/tools/es.exe`。解析失败**不会**被缓存——事后安装无需重启即生效。没有 Everything 时，`search_files` 自动使用原生搜索，`everything_search` 返回结构化安装详情。见[平台说明](../README.zh-CN.md#平台说明)。

## 大目录树上 `search_files` 慢（Linux/macOS）

**原因：** 找不到 `fd` 二进制时，内置原生递归搜索是回退路径。

**处置：** 通过包管理器安装 fd（如 `apt-get install -y fd-find`——二进制可能叫 `fdfind`），或将 `ENHANCED_TERMINAL_FD_PATH` 设为显式路径。无效的显式路径会 fail-closed 返回 `VALIDATION_ERROR`，而不是静默回退。

## 工具列表显示 26 个而不是 27 个

**原因：** 设置了 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`，`file_info` 被移出工具面。

**处置：** 想恢复 `file_info` 就取消该变量并重启服务。`health://status`（`tools.enabled` / `tools.disabled`）报告与 `tools/list` 相同的数量。

## Linux 上 `compress_archive` / `extract_archive` 失败

**原因：** 归档工具调用系统 `zip` / `unzip` 二进制，精简镜像常常没有。

**处置：** 通过包管理器安装（如 `apt-get install -y zip unzip`）。

## 状态目录在哪？能挪吗？

**原因：** 会话、审计日志、page cache 和临时资源默认都在 `<project-root>/.etmcp` 下。该目录（及其 `temp/` 子目录）是懒创建的——只有第一个真实产物落盘时才创建，所以它可能确实还不存在。

**处置：** 设置 `MCP_STATE_DIR` 覆盖。注意：设置覆盖后，`.enhanced-terminal-mcp` 下的 legacy 状态**不会**自动迁移（迁移只发生在默认根目录；`temp/` 与未知文件永不迁移）。

## 怎么看服务在做什么？

**处置：** 三个可观测面——

1. `MCP_LOG_LEVEL=debug` 输出详细 stderr 日志（客户端按自己的 UI 展示）。
2. `MCP_AUDIT_MODE=all` 把每次工具调用记录到 `<state-dir>/logs/audit.jsonl`；通过 `audit://log` 资源读取近期条目。
3. `health://status` 报告 `healthy` / `degraded` / `failed` 及各组件明细（审计写入、临时容量、进程监管、会话持久化）；`telemetry_report` 展示按工具的延迟/错误/缓存指标。

## `off` 模式下命令被 `COMMAND_DANGEROUS` 拦截

**原因：** hardBlock 底线（破坏性模式拦截）在任何模式下都不可关闭，包括 `off`——这是有意设计。

**处置：** 改写命令避开破坏性模式。没有任何配置可以关闭底线；见[安全模型](./safety.zh-CN.md#hardblock-底线始终生效)。
