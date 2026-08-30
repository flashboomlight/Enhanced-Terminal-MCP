# Enhanced Terminal MCP Server v4.1

[![CI](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux%20%C2%B7%20macOS-lightgrey)](#平台说明)

[English Documentation](./README.md)

通过 [模型上下文协议 (Model Context Protocol, MCP)](https://modelcontextprotocol.org/) 为 AI 模型提供终端 / CLI 接口：一个 stdio 服务端，向 AI 助手提供 **27 个工具**，覆盖命令执行、文件读写、文件管理、搜索、系统管理、归档与运维遥测，之上叠加分层安全模型。

> 本文档为英文 `README.md` 的中文翻译版；如有出入，以英文版为准。

> [!WARNING]
> **本服务会在你的机器上执行完整 shell 命令字符串。**其安全层是纵深防御、**而非沙箱**——经确认的命令以你的用户权限运行。不要将其暴露给不可信的客户端或网络；文件系统隔离由宿主沙箱负责。见 [SECURITY.md](./SECURITY.md)。

## 能做什么

- **让 AI 助手执行 shell 命令**——单条、批量或限时 watch；超长输出溢出到 page cache，模型可分页读取而不必重跑。
- **读写与整理本地文件**——分页读取、带秘密扫描的写入保护、复制/移动/删除走逐次确认。
- **快速找文件**——Windows 上经 Everything 亚 10ms 文件名搜索（`es.exe` 需自备），Linux/macOS 上 `fd` 加速，另有正则内容搜索。
- **查看与管理系统**——进程、网络检查、环境变量（敏感值掩码）。
- **处理归档与下载**——zip 压缩/解压与 HTTP(S) 下载，内置体积预算与 SSRF 策略防护。
- **回看服务行为**——结构化审计日志、如实反映组件状态的健康检查、按工具的遥测指标。

## 目录

- [能做什么](#能做什么)
- [快速开始](#快速开始)
- [配置](#配置)
- [工具](#工具)
- [安全与确认](#安全与确认)
- [平台说明](#平台说明)
- [排错](#排错)
- [维护者区](#维护者区)
- [贡献](#贡献)
- [许可证](#许可证)

详细参考文档在 [`docs/`](./docs/)：[安装与客户端接入](./docs/installation.zh-CN.md) · [配置参考](./docs/configuration.zh-CN.md) · [工具参考](./docs/tools.zh-CN.md) · [安全模型与配置档](./docs/safety.zh-CN.md) · [排错](./docs/troubleshooting.zh-CN.md)（英文原版在各对应页顶部切换链接）

## 快速开始

### 1. 从源码安装

npm 包**尚未发布**——当前以源码检出为安装方式：

```bash
git clone https://github.com/flashboomlight/Enhanced-Terminal-MCP.git
cd Enhanced-Terminal-MCP
pnpm install        # 或：npm install
pnpm run build      # 或：npm run build
```

> 构建要求 Node.js 22.13+（固定 pnpm 11.21.0 的要求）。构建出的服务本身兼容 Node.js 20+。

在 Windows 上，`setup.bat` 是另一种引导方式，额外把固定版本、SHA256 校验的便携 pwsh 7 拉取到 `tools/pwsh`（`--no-pwsh` 跳过，`--non-interactive` 适配 CI）。在 Linux/macOS 上，上述安装 + 构建即全部所需。服务在运行期绝不联网下载。

### 2. 接入 MCP 客户端

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "node",
      "args": ["D:\\absolute\\path\\to\\Enhanced-Terminal-MCP\\build\\index.js"],
      "env": {
        "MCP_SAFETY_MODE": "off",
        "MCP_COMMAND_CONFIRMATION": "risk-gated"
      }
    }
  }
}
```

这段 JSON 放在哪取决于客户端——Claude Desktop、Cursor、VS Code、Cherry Studio 各有自己的配置位置；分客户端表格、npm 安装方式（计划中）与安装验证方法（`tools/list` 看到 27 个工具、`health://status` 读出 `healthy`）见 [安装与客户端接入](./docs/installation.zh-CN.md)。

上面的 `env` 块是个人使用推荐配置档；所有变量均可选，见[配置](#配置)。

## 配置

所有选项都是服务进程上的环境变量（客户端的 `env` 块）。常用的几个：

| 变量 | 默认值 | 控制什么 |
|------|--------|----------|
| `MCP_SAFETY_MODE` | `normal` | 受保护工具的 `strict` / `normal` / `off` 门控 |
| `MCP_COMMAND_CONFIRMATION` | `all` | `all` 每条命令都确认；`risk-gated` 普通命令直接执行、重命令确认一次 |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist` 模式筛查或 `allow` 可执行文件白名单 |
| `MCP_SHELL` | `pwsh` | Windows shell：`pwsh` / `powershell` / `cmd`（Unix 恒为 `/bin/sh -c`） |
| `MCP_POWERSHELL_PATH` | — | pwsh/PowerShell 显式路径（最高优先级，fail-closed） |
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | 会话、审计日志、page cache 与临时文件的存放位置 |
| `MCP_AUDIT_MODE` | `errors` | 审计日志 `off` / `errors` / `all` |
| `MCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

完整参考——40 个变量按主题分组（安全、shell、状态/审计、输出/临时文件、搜索引擎、下载/归档），附可直接抄的配置档——见 [docs/configuration.zh-CN.md](./docs/configuration.zh-CN.md)。

## 工具

27 个工具，7 大类（`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时为 26 个）。下面是一行速览；**参数、默认值与输出契约见 [docs/tools.zh-CN.md](./docs/tools.zh-CN.md)**。

### 命令工具
| 工具 | 说明 | 安全 |
|------|------|------|
| `execute_command` | 执行 shell 命令，或经 `cache_id`（`page`/`pageSize`）读取缓存的分页输出 | destructive |
| `batch_execute` | 顺序（默认）或并发 4 执行多条命令 | destructive |
| `watch_command` | 限时运行命令，捕获输出，非零退出即失败 | destructive |

超长输出溢出到 page cache，而不是灌爆上下文：

```
execute_command({ command: "pnpm test" })        → paged: true, cache_id: "…", 共 12 页的第 1 页
execute_command({ cache_id: "…", page: 2 })       → 第 2 页，不重跑测试
```

### 文件工具
| 工具 | 说明 | 缓存 |
|------|------|------|
| `read_file` | 带分页（offset/lines）读取文件，编码自动检测 | 30s |
| `write_file` | 写入或追加内容；秘密扫描拦截凭据写入 | — |
| `list_directory` | 带符号链接环保护的递归列表，批量 stat | 5s |
| `file_info` | 大小、类型、时间戳 | 30s |
| `make_directory` | 创建目录（含父目录） | — |

### 文件管理
| 工具 | 说明 |
|------|------|
| `copy_move` | 复制或移动文件/目录；受安全确认保护 |
| `delete_path` | 删除文件或目录（非空目录需 recursive） |

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
- `health://status` — JSON 健康检查：`healthy` / `degraded` / `failed`，由四个组件聚合（审计写入、临时容量、进程监管、会话持久化）。可直接读取；以模板注册，**不出现在 `resources/list` 中**。
- `audit://log` — 最近的审计条目（默认限制：50）
- `audit://log?limit=N` — 指定限制的最近审计条目（钳制到 1–1000）

### Prompts
- `usage-guide` — 工具概览（包含实时会话上下文）
- `safety-info` — 当前安全配置

## 安全与确认

两层始终生效：

- **安全模式**（`MCP_SAFETY_MODE`）：`strict` 拦截全部十个受保护工具（所有命令工具、写入、删除、复制/移动、归档、下载、杀进程）；`normal` 经 MCP Elicitation 逐次确认受保护操作；`off` 跳过确认。固定的 **hardBlock 底线**在任何模式（含 `off`）下都拦截破坏性命令模式——不可关闭。
- **命令确认**（`MCP_COMMAND_CONFIRMATION`）：`all` 每次命令调用都确认；`risk-gated` 普通命令立即执行，重命令（批量 >5、破坏性残留、性能词汇、watch >60s）携带原因确认一次。

个人代理交互场景的推荐配置档是 `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`：普通命令顺畅执行，重命令携带风险原因停一次。CI 与锁定环境配置档（含 `MCP_COMMAND_POLICY=allow` 可执行文件白名单）见 [docs/safety.zh-CN.md](./docs/safety.zh-CN.md)，信任边界也在其中——本模型是**纵深防御而非沙箱**；按 MCP 规范，文件系统边界执行归宿主沙箱负责。

## 平台说明

### Windows：Shell 解析

在 Windows 上，命令工具每个进程解析一次 shell，顺序如下：

1. `MCP_POWERSHELL_PATH`（显式，fail-closed）
2. `tools/pwsh/pwsh.exe` 处的捆绑便携 pwsh 7（由 `setup.bat` 安装，固定版本 + SHA256 校验）
3. `PATH` 上找到的 pwsh 7
4. Windows PowerShell 5.1 回退（记录警告）

pwsh 7 与 Windows PowerShell 5.1 使用调用层 UTF-8 前导码；cmd 保持 `chcp 65001`。使用 `MCP_SHELL=cmd` 恢复遗留 cmd.exe 行为。切换 shell 或安装 pwsh 后需重启服务（解析结果按进程生命周期缓存）。

### Windows：Everything 搜索（可选）

与 voidtools 的 [Everything](https://www.voidtools.com/) 的可选集成，在 Windows 上提供近乎即时的文件名搜索。**Everything 不随 Enhanced Terminal MCP 分发**——仓库与 npm 包均不包含。启用步骤：

1. 从 voidtools 安装 Everything。
2. 从同一来源获取 Everything CLI（`es.exe`）。
3. 把服务指向你自己的副本：将 `ENHANCED_TERMINAL_ES_PATH` 设为 `es.exe` 的绝对路径，或把文件放到 `<state-dir>/tools/es.exe`。
4. 成功解析按进程生命周期缓存；失败不缓存，下次调用重试——事后安装 `es.exe` 无需重启即可生效。

服务只校验配置路径存在且为普通文件——不下载、不为探测执行任何二进制、不锁定特定 `es.exe` 版本。没有 Everything 时，`search_files` 自动使用原生搜索（Linux/macOS 上可用 `fd`），`everything_search` 返回结构化安装详情而不是伪装成空结果。

### Linux / macOS

- **Shell**：命令执行使用 `/bin/sh -c`。pwsh/PowerShell 解析链（`MCP_SHELL`、`MCP_POWERSHELL_PATH`、捆绑 `tools/pwsh`）仅限 Windows，Linux 上无需任何配置。
- **归档工具**：`compress_archive` / `extract_archive` 调用系统 `zip` / `unzip` 二进制——通过包管理器安装（如 `apt-get install -y zip unzip`）。
- **搜索**：`everything_search` 仅限 Windows；在 Linux/macOS 上 `search_files` 在可用时使用 `fd` 引擎（`PATH` 上的 `fd` 或 `fdfind`，或显式 `ENHANCED_TERMINAL_FD_PATH`），否则回退内置原生递归搜索（同一 partial-result 契约，大树较慢）。通过包管理器安装（如 `apt-get install -y fd-find`）可在大型目录树获得大幅加速。
- 其余一切——安全层、会话持久化、审计日志、page cache、限流——平台中立，[配置参考](./docs/configuration.zh-CN.md)全量原样适用。

## 排错

- **装了 pwsh 却仍用 5.1？** Shell 解析按进程缓存——重启服务。
- **`everything_search` 不可用 / Windows 搜索慢？** Everything（`es.exe`）不随包分发；设置 `ENHANCED_TERMINAL_ES_PATH` 或放到 `<state-dir>/tools/es.exe`。
- **工具是 26 个不是 27 个？** 设置了 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`。
- **Linux 上归档工具失败？** 安装系统 `zip` / `unzip` 二进制。

更多（状态目录位置、审计/日志、hardBlock 拦截、fd 配置）：[docs/troubleshooting.zh-CN.md](./docs/troubleshooting.zh-CN.md)。

## 维护者区

<details>
<summary><b>架构</b></summary>

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
</details>

### 开发

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

开发使用 pnpm `11.21.0`（要求 Node.js 22.13+）。pnpm 可复用机器级共享 content store；store 路径是机器本地配置（用 `pnpm store path` 查看），不属于仓库契约，不得写入仓库文件、包元数据、lockfile 或发布物。每个 MCP 项目保留自己的 `node_modules`、virtual store 与 lockfile。不要在项目之间共享运行时 `node_modules` 或使用 `NODE_PATH`。

### 发布验证

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

### 供应链与完整性

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
