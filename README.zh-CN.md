# Enhanced Terminal MCP Server v4.1

[![CI](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux%20%C2%B7%20macOS-lightgrey)](#linux-说明)

通过 [模型上下文协议 (Model Context Protocol, MCP)](https://modelcontextprotocol.org/) 为 AI 模型提供强大的终端 / CLI 接口。

提供 **27 个工具**，覆盖 7 大类：命令执行、文件读写、文件管理、系统管理、搜索、归档、运维遥测与会话管理。

> 本文档为英文 `README.md` 的中文翻译版；如有出入，以英文版为准。

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
  - [环境变量](#环境变量)
  - [Windows 默认 Shell](#windows-默认-shellpwsh-7)
  - [Everything 搜索](#everything-搜索windows可选)
- [Linux 说明](#linux-说明)
- [工具参考](#工具参考)
- [架构](#架构)
- [开发](#开发)
- [发布验证](#发布验证)
- [供应链与完整性](#供应链与完整性)
- [贡献](#贡献)
- [许可证](#许可证)

## 特性

- **三级安全体系** — 通过 `MCP_SAFETY_MODE` 支持 strict/normal/off；hardBlock 底线在任何模式下始终开启；可选 `MCP_COMMAND_POLICY=allow`
- **风险分级命令确认** — 设置 `MCP_COMMAND_CONFIRMATION=risk-gated` 后，普通命令直接执行，重命令（批量 >5、破坏性残留、性能类词汇、长 watch）通过 MCP Elicitation 携带风险原因确认一次
- **路径与 URL 安全** — 路径穿越检测、禁止路径、敏感文件模式、秘密扫描
- **性能优化** — LRU 结果缓存（128 条，滑动 TTL，约 32MB 上限）、自适应超时、基于 spawn 的流式输出
- **结构化错误** — 31 个错误码，附带 `retryable`、`suggestion`、`param` 提示供 LLM 决策
- **会话持久化** — 工作目录、环境变量与命令历史在重启后保留（自动保存到 `.etmcp/session.json`）
- **惰性状态目录** — `.etmcp` 仅在首个真实产物（会话状态、审计条目、temp/page-cache 资源）落盘时创建；启动、恢复与资源读取零创建
- **审计日志** — 结构化 JSON Lines 审计日志位于 `.etmcp/logs/audit.jsonl`（模式：`off` / `errors` / `all`）
- **临时资源管理器** — TTL + LRU 自动回收临时目录；`temp` 根仅在真正需要临时资源时创建
- **命令输出分页** — 大型 `execute_command` 输出溢出到 `.etmcp/temp` 下的字节索引 page cache v2，可通过校验后的 `cache_id` / `page` / `pageSize` 逐页读取；小输出留在内存、永不落盘
- **限流** — 命令执行使用令牌桶（10 req/s）
- **Windows Everything 集成（可选）** — 通过你自行安装的 Everything CLI 实现亚 10ms 文件搜索，解析 `ENHANCED_TERMINAL_ES_PATH` 或 `<state-dir>/tools/es.exe`；Everything 不随本包分发，不可用时 `search_files` 回退原生搜索
- **可选 fd 搜索引擎（Linux/macOS）** — `search_files` 通过 `PATH` 上的 `fd`/`fdfind` 或显式 `ENHANCED_TERMINAL_FD_PATH`（fail-closed）加速；不可用时静默回退内置原生搜索

## 快速开始

### npm 消费者

发布到 npm 后，在消费项目中安装并使用其 bin 入口。npm 包不包含 setup.bat、源码检出、捆绑 pwsh 或任何 Everything 组件。安装必须允许生命周期脚本，因为 postinstall 会应用固定版本的 MCP SDK 兼容补丁。

```bash
# 全局安装
npm install --global enhanced-terminal-mcp

# 或项目内安装
npm install enhanced-terminal-mcp
```

全局安装的 MCP 配置：

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "enhanced-terminal-mcp"
    }
  }
}
```

项目内安装时，显式使用 npm runner：

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "npx",
      "args": ["--yes", "enhanced-terminal-mcp@4.1.0"]
    }
  }
}
```

npm 消费路径在安装或运行时绝不下载 pwsh。在 Windows 上按 shell 解析器使用显式 `MCP_POWERSHELL_PATH`、`PATH` 上的本地 pwsh，或现有的 Windows PowerShell 5.1 回退。

### 源码检出（全平台）

从仓库根克隆并构建：

```bash
git clone https://github.com/flashboomlight/Enhanced-Terminal-MCP.git
cd Enhanced-Terminal-MCP
pnpm install        # 或：npm install
pnpm run build      # 或：npm run build
```

> 开发工具链要求 Node.js 22.13+（固定 pnpm 11.21.0 的要求）。运行时（npm 包）仍兼容 Node.js 20+。

在 Windows 上，`setup.bat` 是另一种引导方式：使用固定 pnpm 版本安装、构建 `build/index.js`，然后执行固定版本的 pwsh 引导。使用 `setup.bat --no-pwsh` 跳过可选下载，使用 `--non-interactive` 适配 CI 或自动化。在 Linux/macOS 上，普通安装 + 构建即全部所需——无需 pwsh。

把 MCP 客户端指向构建产物入口（绝对路径）：

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/Enhanced-Terminal-MCP/build/index.js"]
    }
  }
}
```

源码检出与 npm 消费路径有意分离：setup.bat 不是 npm 包入口，npm install 也不是源码引导的替代品。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_SAFETY_MODE` | `normal` | `strict`（拦截全部破坏性操作）、`normal`（确认破坏性工具）、`off`（不检查；hardBlock 始终开启） |
| `MCP_COMMAND_CONFIRMATION` | `all` | `all`（normal 模式下每个命令工具调用都确认——默认，行为不变）或 `risk-gated`（普通命令免确认执行；重命令——批量 >5、破坏性残留、性能词汇、watch >60s——需要一次携带风险原因的 Elicitation 确认；在 `off` 下同样生效，仅豁免普通命令）。非法值回退 `all` 并给出启动警告。`strict` 始终拦截命令工具。 |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist`（危险模式 + hardBlock）或 `allow`（可执行文件白名单 + hardBlock；禁止 shell 链式调用） |
| `MCP_COMMAND_ALLOW` | 内置列表 | policy 为 `allow` 时的逗号分隔可执行文件/前缀（如 `npm,git,node`） |
| `MCP_BATCH_RATE_MODE` | `batch` | `batch`（每次 batch_execute 1 令牌）或 `per_command`（批内每条命令 1 令牌） |
| `MCP_SECRETS_SCAN` | `cache` | `off` / `write` / `cache` / `strict`（strict 同时拦截含秘密的 read_file 内容，并在内容超出 4 MiB 扫描容量时 fail-closed） |
| `MCP_ENV_VALUE_MODE` | `allowlist` | `environment_vars` 值显示：`allowlist`（仅内置非敏感键 + `MCP_ENV_VALUE_ALLOWLIST`）、`full`（全部非敏感值）、`keys`（值始终掩码）。敏感关键词在任何模式下都掩码；显示值经秘密脱敏；结果永不缓存。 |
| `MCP_ENV_VALUE_ALLOWLIST` | — | 逗号分隔的额外环境变量名（不区分大小写、精确匹配），其值可在 `allowlist` 模式下显示 |
| `MCP_SESSION_PERSIST_ENV_VALUES` | `0` | 设为 `1` 将会话环境变量值持久化到 `session.json`。默认关闭：仅持久化键名。拒绝名单键（`PATH`、`NODE_OPTIONS`、…，大小写不敏感匹配）与敏感键永不持久化。命令历史无论开关都经脱敏后持久化。 |
| `MCP_LOG_LEVEL` | `info` | 日志级别：debug / info / warn / error |
| `MCP_SHELL` | `pwsh` | Windows shell 模式：`pwsh`（PowerShell 7，推荐）、`powershell`（Windows PowerShell 5.1）、`cmd`（遗留 cmd.exe 逃生通道）。Unix 不受影响。 |
| `MCP_POWERSHELL_PATH` | — | pwsh 7 / PowerShell 可执行文件的显式路径。优先级最高；无效路径为硬错误（不静默回退）。 |
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | 会话、审计日志与临时文件的状态目录。使用默认根时，遗留的 `<project-root>/.enhanced-terminal-mcp` 中 `session.json`/`logs/audit.jsonl` 会被迁移；`temp` 与未知文件永不迁移。设置此覆盖项会禁用自动遗留迁移。 |
| `MCP_AUDIT_MODE` | `errors` | 审计模式：`off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | 按条数压缩保留的审计日志最大条数（也是 `recent()` 读取窗口） |
| `MCP_AUDIT_QUEUE_MAX_ENTRIES` | `2000` | 内存审计队列最大条数；溢出丢最旧并递增可观测 `dropped` 计数 |
| `MCP_AUDIT_QUEUE_MAX_BYTES` | `4194304` | 内存审计队列字节上限（4 MiB）；溢出丢最旧并递增 `dropped` |
| `MCP_AUDIT_MAX_ENTRY_BYTES` | `65536` | 每条序列化审计条目的字节上限（64 KiB）；超限条目保留 `{truncated: true}` 骨架而非丢弃 |
| `MCP_AUDIT_MAX_FILE_BYTES` | `8388608` | 审计文件大小上限（8 MiB）；成功写入超过上限后轮转为 `audit.jsonl.1` |
| `MCP_AUDIT_MAX_ROTATIONS` | `1` | 保留的轮转代数（`audit.jsonl.1` … `.N`）；`0` 直接删除轮转文件 |
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | 每条命令保留的 stdout 捕获上限；超过后结果标记 `truncated` 并溢出到 page cache；见 `MCP_COMMAND_MEMORY_OUTPUT_BYTES` 了解内存溢出阈值 |
| `MCP_TEMP_TTL_MS` | `3600000` | 临时目录 TTL（毫秒） |
| `MCP_MAX_TEMP_DIRS` | `100` | LRU 淘汰前的最大临时目录数 |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | 自动清理轮询间隔（毫秒） |
| `MCP_COMMAND_MEMORY_OUTPUT_BYTES` | `1048576` | 每条命令的内存保留阈值；超过部分溢出到 page cache（`paged=true`） |
| `MCP_COMMAND_MAX_STDERR_BYTES` | `1048576` | 每条命令保留的 stderr 上限 |
| `MCP_TEMP_MAX_TOTAL_BYTES` | `1073741824` | LRU 淘汰触发前的临时总字节上限。跨进程的未完成预留经 `<state-dir>/temp/.quota.json` 镜像共享（死亡进程的陈旧条目自动回收）；协调文件（`.quota.json`、`.temp.lock`）不计入载荷预算 |
| `ENHANCED_TERMINAL_ES_PATH` | — | 指向你自行安装的 Everything CLI（`es.exe`）的显式路径。优先于 `<state-dir>/tools/es.exe`；必须是已存在的普通文件，无效显式路径 fail-closed（不静默回退、不锁版本）。仅当隐式状态二进制不可用时 `search_files` 才回退；`everything_search` 返回结构化安装详情。Everything 不随本包分发。 |
| `ENHANCED_TERMINAL_FD_PATH` | — | 非 Windows `search_files` 加速用的 `fd` 可执行文件显式路径。必须为绝对路径 + 文件 + 通过 `--version` 探测；无效显式路径 fail-closed（`VALIDATION_ERROR`，不静默回退）。未设置时，每个进程探测一次 `PATH` 上的 `fd` / `fdfind`；都没有则静默使用原生搜索。 |
| `MCP_SSRF_MODE` | 按面默认 | `deny-private` / `allow-private`。未设置：`download_file` 使用 `deny-private`（拦截环回/私网/链路本地/元数据目标，含 `169.254.169.254`），`network_info` 使用 `allow-private`（诊断不受影响）。显式值对两个面生效。禁用地址（未指定/多播/保留）始终拦截。永不使用代理环境变量。 |
| `MCP_DOWNLOAD_MAX_BYTES` | `104857600` | 每次下载实际接收的最大字节数（100 MiB）；跨重试共享。超限中止流并删除 staging 文件。 |
| `MCP_DOWNLOAD_TIMEOUT_MS` | `120000` | 下载绝对截止时间（覆盖整个重定向链与重试）。 |
| `MCP_DOWNLOAD_MAX_REDIRECTS` | `5` | 最大重定向跳数；每一跳重新解析并重新按 SSRF 策略校验。 |
| `MCP_ARCHIVE_MAX_MEMBERS` | `10000` | 解压清单与压缩源预遍历的最大归档成员数。 |
| `MCP_ARCHIVE_MAX_MEMBER_BYTES` | `268435456` | 每个归档成员的最大展开字节数（256 MiB）；对清单与真实展开流双重执行。 |
| `MCP_ARCHIVE_MAX_EXPANDED_BYTES` | `1073741824` | 每次解压的最大总展开字节数（1 GiB）；双重执行（清单预检 + 实时计数）。 |
| `MCP_ARCHIVE_MAX_INPUT_BYTES` | `1073741824` | `compress_archive` 的最大源总字节数（1 GiB）；spawn 压缩器前拒绝。 |
| `MCP_ARCHIVE_MAX_RATIO` | `200` | 展开/压缩最大比率，仅对展开超过 64 MiB 的成员生效（zip 炸弹防护）。 |
| `MCP_RESPONSE_MAX_BYTES` | `2097152` | 序列化工具响应的硬上限（文本内容 + 结构化内容，UTF-8 字节）。超限的成功响应降级为 `RESOURCE_LIMIT` 错误信封；非法值带警告回退默认值。没有无限制设置。 |
| `ENHANCED_TERMINAL_DISABLE_FILE_INFO` | — | 设为 `1` 禁用 `file_info` 工具；工具面从 27 降到 26。Banner、`health://status`（`tools.enabled/disabled`）与 usage-guide prompt 报告与 `tools/list` 相同的启用数。 |

### Windows 默认 Shell（pwsh 7）

在 Windows 上，命令工具每个进程解析一次 shell，顺序如下：

1. `MCP_POWERSHELL_PATH`（显式，fail-closed）
2. `tools/pwsh/pwsh.exe` 处的捆绑便携 pwsh 7（由 `setup.bat` 安装，固定版本 + SHA256 校验）
3. `PATH` 上找到的 pwsh 7
4. Windows PowerShell 5.1 回退（记录警告）

pwsh 7 与 Windows PowerShell 5.1 使用调用层 UTF-8 前导码；cmd 保持 `chcp 65001`。使用 `MCP_SHELL=cmd` 恢复遗留 cmd.exe 行为。cmd/powershell 内联非 ASCII 乱码问题已在 M2 输出解码层（`src/command-output.ts`）修复。切换 shell 或安装 pwsh 后需重启服务（解析结果按进程生命周期缓存）。

### Everything 搜索（Windows，可选）

与 voidtools 的 [Everything](https://www.voidtools.com/) 的可选集成，在 Windows 上提供近乎即时的文件名搜索。**Everything 不随 Enhanced Terminal MCP 分发**——仓库与 npm 包均不包含。启用步骤：

1. 从 voidtools 安装 Everything。
2. 从同一来源获取 Everything CLI（`es.exe`）。
3. 把服务指向你自己的副本：将 `ENHANCED_TERMINAL_ES_PATH` 设为 `es.exe` 的绝对路径，或把文件放到 `<state-dir>/tools/es.exe`。
4. 成功解析按进程生命周期缓存；失败不缓存，下次调用重试——事后安装 `es.exe` 无需重启即可生效。

服务只校验配置路径存在且为普通文件——不下载、不为探测执行任何二进制、不锁定特定 `es.exe` 版本。没有 Everything 时，`search_files` 自动使用原生搜索（Linux/macOS 上可用 `fd`），`everything_search` 返回结构化安装详情而不是伪装成空结果。

## Linux 说明

- **Shell**：命令执行使用 `/bin/sh -c`。pwsh/PowerShell 解析链（`MCP_SHELL`、`MCP_POWERSHELL_PATH`、捆绑 `tools/pwsh`）仅限 Windows，Linux 上无需任何配置。
- **归档工具**：`compress_archive` / `extract_archive` 调用系统 `zip` / `unzip` 二进制——通过包管理器安装（如 `apt-get install -y zip unzip`）。
- **搜索**：`everything_search` 仅限 Windows；在 Linux/macOS 上 `search_files` 在可用时使用 `fd` 引擎（`PATH` 上的 `fd` 或 `fdfind`，或显式 `ENHANCED_TERMINAL_FD_PATH`），否则回退内置原生递归搜索（同一 partial-result 契约，大树较慢）。通过包管理器安装（如 `apt-get install -y fd-find`）可在大型目录树获得大幅加速。
- 其余一切——安全层、会话持久化、审计日志、page cache、限流——平台中立，上表环境变量全部原样适用。

## 工具参考

### 命令工具
| 工具 | 说明 | 安全 |
|------|------|------|
| `execute_command` | 执行 shell 命令，或经 `cache_id`（`page`/`pageSize`）读取缓存的分页输出 | destructive |
| `batch_execute` | 顺序（默认）或并发 4 执行多条命令 | destructive |
| `watch_command` | 限时运行命令，捕获输出，非零退出即失败 | destructive |

### 文件工具
| 工具 | 说明 | 缓存 |
|------|------|------|
| `read_file` | 带分页（offset/limit）读取文件，编码自动检测 | 30s |
| `write_file` | 写入或追加内容；秘密扫描拦截凭据写入 | — |
| `list_directory` | 带符号链接环保护的递归列表，批量 stat | 5s |
| `file_info` | 大小、类型、时间戳 | 30s |
| `make_directory` | 创建目录（含父目录） | — |

### 文件管理
| 工具 | 说明 |
|------|------|
| `copy_move` | 复制或移动文件/目录；受安全确认保护 |
| `delete_path` | 删除文件或目录（非空目录需 recursive） |

个人代理交互场景的推荐配置是 `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`：普通命令顺畅执行，重命令携带风险原因确认一次。按 MCP 规范，文件系统边界执行归宿主沙箱负责；本服务刻意不保留目录白名单（v4.0.0 已移除此前的 `MCP_CONFIRMATION_MODE=headless` / `MCP_ALLOWED_ROOTS` 机制）。

### 搜索工具
| 工具 | 说明 | 缓存 |
|------|------|------|
| `search_files` | 模式搜索：Windows 用 Everything，Linux/macOS 可用时用 fd，否则原生回退 | 30s |
| `everything_search` | 超快 Everything 搜索（仅 Windows） | — |
| `grep_content` | 经 PowerShell/grep/native 的正则内容搜索，带全局 `max_results` | 30s |

搜索与 `list_directory` 结果携带 partial-result 契约：`complete`（遍历/读取错误被跳过时为 false）、`warnings`（有界结构化警告码）、`truncated`（预算用尽）。Partial（`complete=false`）结果永不缓存。

### 系统工具
| 工具 | 说明 |
|------|------|
| `get_system_info` | OS、CPU、内存、磁盘、GPU 详情（60s 缓存） |
| `process_list` | 可过滤的进程列表 |
| `kill_process` | 按 PID 或名称终止（受保护进程被拦截） |
| `network_info` | config / connections / ping / dns |
| `environment_vars` | 敏感键掩码的环境变量列表 |

### 归档工具
| 工具 | 说明 |
|------|------|
| `compress_archive` | Zip 压缩；受安全确认保护 |
| `extract_archive` | Zip 解压；受安全确认保护 |
| `download_file` | 带重试的 HTTP(S) 下载；受安全确认保护 |

### 实用工具
| 工具 | 说明 |
|------|------|
| `telemetry_report` | 工具调用指标：延迟、错误、缓存命中率、temp 统计、审计状态 |
| `temp_stats` | 临时资源统计：目录数、大小、最老/最新年龄、移除计数 |
| `cache_stats` | LRU 缓存统计 |
| `cache_invalidate` | 清除指定或全部缓存 |
| `session_state` | 查看/修改会话工作目录与环境（get/set_cwd/set_env/reset）；环境作用于命令工具 |
| `pool_stats` | 进程池状态（当前无激活；没有活动的 worker 池） |

### 资源
- `health://status` — JSON 健康检查，含版本、指标、缓存、会话、临时与审计信息。`status` 为 `healthy` / `degraded` / `failed`（不再是恒定的 `ok`），由四个组件聚合（`components.audit` 写入失败/队列丢弃、`components.temp` 容量拒绝/清理锁失败、`components.process` 子进程终止失败、`components.session` 持久化失败）
- `audit://log` — 最近的审计条目（默认限制：50）
- `audit://log?limit=N` — 指定限制的最近审计条目（钳制到 1–1000）

### Prompts
- `usage-guide` — 工具概览（包含实时会话上下文）
- `safety-info` — 当前安全配置

## 架构

```
MCP Client (stdio) → McpServer
  ├─ 7 个工具模块（command、files、manage、search、system、archive、utility）
  ├─ 实用工具（telemetry、temp、cache、session、pool_stats、…）
  ├─ wrapHandler 中间件（遥测 + LRU 缓存）
  ├─ 安全层（路径校验、危险模式、秘密）
  ├─ SafeGuard（三级安全模式）
  ├─ 限流（令牌桶）
  ├─ 会话持久化（JSON 文件）
  ├─ ProcessPool（非活跃 stub；统计用途——执行使用 spawnStream）
  ├─ 自适应超时（P95 基准 × 3）
  └─ 结构化错误（31 个错误码）
```

## 开发

```bash
pnpm install
pnpm run build          # 清理 build/ 并编译 TypeScript
pnpm exec tsc --noEmit  # 仅类型检查，不产出
pnpm test               # 运行单元测试
pnpm run test:conformance   # 真实 stdio MCP 协议检查
pnpm run test:hostile-input # 有界/策略恶意输入语料
pnpm run test:platform-smoke # 最小跨平台服务冒烟
pnpm run test:latency   # 端到端延迟基准
pnpm run lint           # Biome 检查
pnpm run format         # Biome 格式化
pnpm run gate            # 规范发布门禁（全部阶段阻断）
pnpm run gate -- --ci   # 同一门禁；CI 中 latency 显式为 advisory
```

开发使用 pnpm `11.21.0`（要求 Node.js 22.13+）。pnpm 可复用机器级共享 content store；store 路径是机器本地配置（用 `pnpm store path` 查看），不属于仓库契约，不得写入仓库文件、包元数据、lockfile 或发布物。每个 MCP 项目保留自己的 `node_modules`、virtual store 与 lockfile。不要在项目之间共享运行时 `node_modules` 或使用 `NODE_PATH`。发布的包仍可按快速开始所示用 npm 安装。

## 发布验证

维护者发布前应运行 `pnpm run gate`。它是唯一的规范发布门禁，依次运行：清理构建、类型检查、lint、全量测试、主/工具层覆盖率底线、延迟、生产依赖审计、真实 npm tarball 校验器与干净消费者检查。各阶段也可用以下命令单独运行；校验器不发布、不上传、不签名，也不替代 CI provenance。

```bash
pnpm run audit:prod
pnpm run build
node scripts/verify-package.mjs
```

verify-package.mjs 与 verify-clean-consumer.mjs 是源码维护工具，不随 npm 包发布。干净消费者检查针对真实 tarball 运行：

```bash
node scripts/verify-clean-consumer.mjs <path-to-tarball>
```

校验器 JSON 输出、pnpm 审计结果、lockfile、SBOM 与 CI 生成的 provenance 必须作为同一份发布证据保存。本地 SHA-256 只能证明 tarball 内容摘要；它不是签名或 provenance。

## 供应链与完整性

| 资产 | 说明 |
|------|------|
| `scripts/apply-mcp-sdk-patch.mjs` | `@modelcontextprotocol/sdk@1.29.0` 的零依赖 `postinstall` 补丁；只解析包自有的 SDK，版本、布局或模式漂移即 fail-closed。`patch-package` 仅作为 **devDependency**。 |
| SDK 固定 | `@modelcontextprotocol/sdk` 保持精确 `1.29.0` 以维持 wire/API 兼容；其补丁后的传递依赖版本冻结在 `pnpm-lock.yaml`。 |
| 包校验器 | `scripts/verify-package.mjs` 检查真实 tarball、包文件、入口、source map、禁止的本地资产与 SHA-256。 |
| Zod | 依据记录在案的决策（2026-07-12）保持 **v3**，直到 zod v4 迁移验证完成。 |

第三方归属与分发边界（MCP SDK 兼容补丁、Zod、Everything、pwsh bootstrap）记录在 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)，该文件随 npm 包一并发布。

使用完整 shell 字符串时，安全策略是**纵深防御而非沙箱**——威胁模型、hardBlock 底线、依赖策略与漏洞报告渠道见 [`SECURITY.md`](./SECURITY.md)。硬化路线图（`2026-07-12-remaining-hardening`、`2026-08-28-production-hardening`）已关闭；当前发布状态见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 贡献

欢迎贡献——请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)（改动 `src/security.ts` / `src/safeguard.ts` 前务必注意其中的安全红线），遵守[行为准则](./CODE_OF_CONDUCT.md)，漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 许可证

[MIT](./LICENSE)——第三方归属见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，版本变更见 [CHANGELOG.md](./CHANGELOG.md)。
