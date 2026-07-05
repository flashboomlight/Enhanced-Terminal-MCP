# Enhanced Terminal MCP 架构总入口

> 状态：已填充
> 创建日期：2026-07-05
> 更新日期：2026-07-05

## 1. 项目简介

Enhanced Terminal MCP 是一个基于 Model Context Protocol (MCP) 的终端增强服务器，为 AI 客户端提供文件操作、命令执行、搜索、归档、系统监控等能力。

## 2. 核心概念 / 术语表

- **MCP**：Model Context Protocol，AI 模型与外部工具的标准通信协议
- **Tool**：MCP 工具，每个工具对应一个具体能力
- **Session**：会话状态，包含当前工作目录、环境变量、命令历史
- **Safety Mode**：安全模式，控制危险操作的拦截策略
- **Telemetry**：工具调用指标收集
- **Audit Log**：结构化审计日志，记录关键操作
- **Temp Manager**：临时资源生命周期管理器（TTL + LRU）
- **Page Cache**：命令输出分页缓存

## 3. 子系统 / 模块索引

| 模块 | 路径 | 职责 |
|---|---|---|
| 入口 | `src/index.ts` | MCP 服务器注册、生命周期、优雅退出 |
| 命令执行 | `src/tools/command.ts` | execute_command / batch_execute / watch_command |
| 文件操作 | `src/tools/files.ts` | read_file / write_file 等 |
| 搜索 | `src/tools/search.ts` | search_files / grep_content |
| 归档 | `src/tools/archive.ts` | compress / extract |
| 系统 | `src/tools/system.ts` | process / network / system info |
| 工具管理 | `src/tools/manage.ts` | copy / move / delete |
| Utility | `src/tools/utility.ts` | telemetry / cache / session / pool / temp_stats |
| 安全 | `src/security.ts` | 路径校验、危险命令检测 |
| 安全确认 | `src/safeguard.ts` | 三级别安全模式确认 |
| 会话 | `src/session.ts` | 会话状态持久化 |
| 状态目录 | `src/state-dir.ts` | 统一状态目录解析与创建 |
| 审计日志 | `src/audit.ts` | 结构化审计日志写入与读取 |
| 临时资源 | `src/temp-manager.ts` | 临时目录 TTL + LRU 回收 |
| 分页缓存 | `src/paging.ts` | 命令输出分页存储与读取 |
| 缓存 | `src/cache.ts` | LRU 工具结果缓存 |
| 进程池 | `src/pool.ts` | shell 进程复用 |
| 流式执行 | `src/stream.ts` | spawn 流式命令执行 |
| 平台适配 | `src/platform.ts` | Windows/Unix shell 统一 |

## 4. 状态目录结构

```
<project-root>/.enhanced-terminal-mcp/
├── session.json
├── logs/
│   └── audit.jsonl
└── temp/
    └── page-cache/
        └── {id}/
            ├── stdout.txt
            ├── stderr.txt
            └── meta.json
```

## 5. 关键架构决定

- 使用 TypeScript + ESM + Node16 module resolution
- 命令执行基于 `node:child_process` spawn 流式收集，避免大输出缓冲
- 安全层前置：路径校验 + 危险模式检测 + 安全模式确认
- 工具结果统一 `ToolResult` 协议，支持结构化输出
- 会话状态 JSON 持久化到项目目录，支持服务重启恢复
- 审计日志使用 JSON Lines 格式，按模式 `off/errors/all` 控制写入
- 临时资源统一由 `TempManager` 管理，TTL + LRU 自动回收
- 命令大输出写入分页缓存，支持 `cache_id`/`page`/`pageSize` 翻页

## 6. 已知约束 / 硬边界

- Windows 与 Unix shell 行为差异由 `src/platform.ts` 统一处理
- 命令超时默认 30s，最大输出 10MB
- 命令历史保留 50 条，持久化时保留 20 条
- 安全模式由 `MCP_SAFETY_MODE` 环境变量控制
- 状态目录由 `MCP_STATE_DIR` 覆盖，默认位于项目根目录
- 审计日志最大保留条目数由 `MCP_AUDIT_MAX_ENTRIES` 控制
- 临时资源 TTL / 数量上限 / 清理间隔由 `MCP_TEMP_TTL_MS` / `MCP_MAX_TEMP_DIRS` / `MCP_TEMP_CLEANUP_INTERVAL_MS` 控制
- 分页单页大小默认 2000 字符，最大 10000 字符
