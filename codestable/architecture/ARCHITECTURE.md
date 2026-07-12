# Enhanced Terminal MCP 架构总入口

> 状态：已填充
> 创建日期：2026-07-05
> 更新日期：2026-07-12

## 1. 项目简介

Enhanced Terminal MCP 是一个基于 Model Context Protocol (MCP) 的终端增强服务器，为 AI 客户端提供文件操作、命令执行、搜索、归档、系统监控等能力。

## 2. 核心概念 / 术语表

- **MCP**：Model Context Protocol，AI 模型与外部工具的标准通信协议
- **Tool**：MCP 工具，每个工具对应一个具体能力；工具数量由 `getRegisteredToolCount()` 动态统计
- **Session**：会话状态，包含当前工作目录、环境变量、命令历史；恢复时校验 cwd 与 env 黑名单
- **Safety Mode**：安全模式，控制危险操作的拦截策略（strict / normal / off）
- **hardBlock**：不可关闭的灾难性命令硬底线（所有安全模式含 off 均生效）
- **Telemetry**：工具调用指标收集
- **Audit Log**：结构化审计日志，记录关键操作
- **Temp Manager**：临时资源生命周期管理器（TTL + LRU）
- **Page Cache**：命令输出分页缓存
- **Process Pool**：历史预热池接口；当前为 inactive stub，`pool_stats` 恒为空，实际执行走 `spawnStream`

## 3. 子系统 / 模块索引

| 模块 | 路径 | 职责 |
|---|---|---|
| 入口 | `src/index.ts` | MCP 服务器注册、生命周期、优雅退出 |
| 命令执行 | `src/tools/command.ts` | execute_command / batch_execute / watch_command |
| 文件操作 | `src/tools/files.ts` | read_file / write_file 等 |
| 搜索 | `src/tools/search.ts` | search_files / everything_search / grep_content |
| 归档 | `src/tools/archive.ts` | compress / extract / download |
| 系统 | `src/tools/system.ts` | process / network / system info |
| 工具管理 | `src/tools/manage.ts` | copy / move / delete |
| Utility | `src/tools/utility.ts` | telemetry / cache / session / pool_stats / temp_stats |
| 安全 | `src/security.ts` | 路径校验、危险命令、hardBlock、realpath |
| 安全确认 | `src/safeguard.ts` | 三级别安全模式确认 |
| 会话 | `src/session.ts` | 会话状态持久化与恢复消毒 |
| 状态目录 | `src/state-dir.ts` | 统一状态目录解析与创建 |
| 审计日志 | `src/audit.ts` | 结构化审计日志写入与读取 |
| 临时资源 | `src/temp-manager.ts` | 临时目录 TTL + LRU 回收 |
| 分页缓存 | `src/paging.ts` | 命令输出分页存储与读取 |
| 缓存 | `src/cache.ts` | LRU 工具结果缓存（滑动 TTL + 内存上限） |
| 进程池 | `src/pool.ts` | inactive stub（仅 stats / 生命周期钩子） |
| es 完整性 | `src/es-integrity.ts` | es.exe SHA-256 校验后才允许执行 |
| 流式执行 | `src/stream.ts` | spawn 流式命令执行 |
| 平台适配 | `src/platform.ts` | Windows / Linux / macOS shell 与系统信息 |

## 4. 状态目录结构

```
<project-root>/.enhanced-terminal-mcp/
├── session.json
├── logs/
│   └── audit.jsonl
└── temp/
    └── page-cache-{timestamp}-{random}/
        ├── .meta.json
        ├── stdout.txt
        ├── stderr.txt
        └── meta.json
```

## 5. 关键架构决定

- 使用 TypeScript + ESM + Node16 module resolution，运行时要求 Node.js 20+
- 命令执行基于 `node:child_process` spawn 流式收集，避免大输出缓冲
- 安全层前置：路径校验 + realpath + 危险模式 + hardBlock + 安全模式确认
- 工具结果统一 `ToolResult` 协议，支持结构化输出
- 会话状态 JSON 持久化到项目目录；恢复时拒绝危险 env 键与非法 cwd
- 审计日志使用 JSON Lines 格式，按模式 `off/errors/all` 控制写入
- 临时资源统一由 `TempManager` 管理，TTL + LRU 自动回收
- 命令大输出写入分页缓存，支持经校验的 `cache_id`/`page`/`pageSize` 翻页
- Everything `es.exe` 仅在 SHA-256 与锁定哈希一致时执行
- 进程池预热未接入执行路径；`pool_stats` 诚实报告 inactive

## 6. 已知约束 / 硬边界

- Windows 与 Unix shell 行为差异由 `src/platform.ts` 统一处理；macOS 系统信息走 sysctl，Linux 走 /proc+free
- 命令超时默认 30s，最大输出由 `MCP_COMMAND_MAX_OUTPUT_BYTES` 控制，默认 50MB
- 命令历史保留 50 条，持久化时保留 20 条
- 安全模式由 `MCP_SAFETY_MODE` 环境变量控制；hardBlock 不可关闭
- 安全确认覆盖命令执行、删除、覆写、复制/移动、归档写入/解压和下载写入
- 状态目录由 `MCP_STATE_DIR` 覆盖，默认位于项目根目录
- 审计日志最大保留条目数由 `MCP_AUDIT_MAX_ENTRIES` 控制
- 临时资源 TTL / 数量上限 / 清理间隔由 `MCP_TEMP_TTL_MS` / `MCP_MAX_TEMP_DIRS` / `MCP_TEMP_CLEANUP_INTERVAL_MS` 控制
- 分页单页大小默认 2000 字符，最大 10000 字符
- 结果缓存默认 128 条、滑动 TTL、约 32MB 近似内存上限
- hardBlock 为尽力而为的黑名单；可选 `MCP_COMMAND_POLICY=allow` 启用前缀白名单（仍叠加 hardBlock）
- 结果缓存对含密钥扫描命中的内容不写入 LRU
