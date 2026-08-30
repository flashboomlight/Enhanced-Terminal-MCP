# 配置参考

[English](./configuration.md)

> 本文为英文 `configuration.md` 的中文翻译版；如有出入，以英文版为准。

所有运行时选项都是 MCP 服务进程上的环境变量（客户端的 `env` 块，或启动它的 shell）。无效的枚举值回退为默认值并记录启动警告；没有隐藏的配置文件。

安全类变量的概念性解释见[安全模型与配置档](./safety.zh-CN.md)。最小配置下，README 的[快速开始](../README.zh-CN.md#快速开始)一个变量都不需要——所有变量都是可选的。

## 安全与确认

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_SAFETY_MODE` | `normal` | `strict`（全部破坏性操作被拦截）、`normal`（确认破坏性工具）、`off`（不检查；hardBlock 仍生效） |
| `MCP_COMMAND_CONFIRMATION` | `all` | `all`（normal 模式下每次命令工具调用都确认——默认，既有行为）或 `risk-gated`（普通命令免确认直接执行；重命令——批量 >5、破坏性残留、性能词汇、watch >60s——携带风险原因经一次 Elicitation 确认；在 `off` 下也生效，只豁免普通命令）。无效值回退为 `all` 并记录启动警告。无论此项如何设置，`strict` 仍拦截命令工具。 |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist`（危险模式 + hardBlock）或 `allow`（可执行文件白名单 + hardBlock；无 shell 串联） |
| `MCP_COMMAND_ALLOW` | 内置列表 | 策略为 `allow` 时的逗号分隔可执行文件/前缀（如 `npm,git,node`） |
| `MCP_SECRETS_SCAN` | `cache` | `off` / `write` / `cache` / `strict`（strict 还会拦截含秘密的 read_file 内容，且内容超出 4 MiB 扫描器容量时 fail-closed） |

## Shell（Windows）

Unix 命令执行恒用 `/bin/sh -c`；这些变量只影响 Windows。解析结果按进程缓存——换 shell 或安装 pwsh 需要重启服务。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_SHELL` | `pwsh` | Windows shell 模式：`pwsh`（PowerShell 7，推荐）、`powershell`（Windows PowerShell 5.1）、`cmd`（遗留 cmd.exe 逃生口）。Unix 不受影响。 |
| `MCP_POWERSHELL_PATH` | — | pwsh 7 / PowerShell 可执行文件的显式路径。最高优先级；无效路径是硬错误（不静默回退）。 |

## 状态、会话与日志

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | 会话、审计日志与临时文件的状态目录。默认根目录下，legacy 的 `<project-root>/.enhanced-terminal-mcp` `session.json`/`logs/audit.jsonl` 会被迁移；`temp` 与未知文件永不迁移。设置此覆盖会禁用自动 legacy 迁移。 |
| `MCP_SESSION_PERSIST_ENV_VALUES` | `0` | 设为 `1` 会把会话 env 值持久化到 `session.json`。默认关闭：只持久化 env 键名。拒绝列表键（`PATH`、`NODE_OPTIONS` 等，不区分大小写匹配）与敏感键永不持久化。命令历史无论开关都经脱敏持久化。 |
| `MCP_LOG_LEVEL` | `info` | 日志级别：debug / info / warn / error |
| `MCP_ENV_VALUE_MODE` | `allowlist` | `environment_vars` 的值展示：`allowlist`（仅内置非敏感键 + `MCP_ENV_VALUE_ALLOWLIST` 展示值）、`full`（所有非敏感值）、`keys`（值始终掩码）。敏感关键词在任何模式下都掩码；展示值经秘密脱敏器处理；结果永不缓存。 |
| `MCP_ENV_VALUE_ALLOWLIST` | — | 逗号分隔的额外 env 键名（不区分大小写、精确匹配），`allowlist` 模式下 `environment_vars` 可展示其值 |

## 审计日志

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_AUDIT_MODE` | `errors` | 审计模式：`off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | 经条数压缩保留的最大审计条目数（也是 `recent()` 的读取窗口） |
| `MCP_AUDIT_QUEUE_MAX_ENTRIES` | `2000` | 内存审计队列的最大条目数；溢出丢弃最旧条目并递增可观测的 `dropped` 计数 |
| `MCP_AUDIT_QUEUE_MAX_BYTES` | `4194304` | 内存审计队列的字节上限（4 MiB）；溢出丢弃最旧条目并递增 `dropped` |
| `MCP_AUDIT_MAX_ENTRY_BYTES` | `65536` | 单条序列化审计条目的字节上限（64 KiB）；超长条目保留 `{truncated: true}` 骨架而不是丢弃 |
| `MCP_AUDIT_MAX_FILE_BYTES` | `8388608` | 审计文件大小上限（8 MiB）；某次成功写入跨过上限后轮转为 `audit.jsonl.1` |
| `MCP_AUDIT_MAX_ROTATIONS` | `1` | 保留的轮转代数（`audit.jsonl.1` … `.N`）；`0` 表示删除轮转文件 |

## 命令输出与临时文件

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | 每条命令保留的 stdout 捕获字节上限，超过后结果标记 `truncated` 并溢出到 page cache；内存溢出阈值见 `MCP_COMMAND_MEMORY_OUTPUT_BYTES` |
| `MCP_COMMAND_MEMORY_OUTPUT_BYTES` | `1048576` | 每条命令的内存保留阈值；超出部分溢出到 page cache（`paged=true`） |
| `MCP_COMMAND_MAX_STDERR_BYTES` | `1048576` | 每条命令保留的 stderr 字节上限 |
| `MCP_BATCH_RATE_MODE` | `batch` | `batch`（每次 batch_execute 消耗 1 个令牌）或 `per_command`（批内每条命令消耗 1 个令牌） |
| `MCP_TEMP_TTL_MS` | `3600000` | 临时目录 TTL（毫秒） |
| `MCP_MAX_TEMP_DIRS` | `100` | 触发 LRU 驱逐前的最大临时目录数 |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | 自动清理轮询间隔（毫秒） |
| `MCP_TEMP_MAX_TOTAL_BYTES` | `1073741824` | 触发 LRU 驱逐前的临时字节总量上限。未结预留跨服务进程经 `<state-dir>/temp/.quota.json` 共享（死进程的陈旧条目自动回收）；协调文件（`.quota.json`、`.temp.lock`）不计入负载预算 |

## 搜索引擎

两个引擎都是可选的，运行期绝不下载。完整解析链见 README 的[平台说明](../README.zh-CN.md#平台说明)。

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENHANCED_TERMINAL_ES_PATH` | — | 你自行安装的 Everything CLI（`es.exe`）显式路径。优先于 `<state-dir>/tools/es.exe`；必须是存在的普通文件，无效的显式路径 fail-closed（不静默回退、无版本锁定）。仅当隐式 state 二进制不可用时 `search_files` 才回退；`everything_search` 返回结构化安装详情。Everything 不随本包分发。 |
| `ENHANCED_TERMINAL_FD_PATH` | — | 用于非 Windows `search_files` 加速的 `fd` 可执行文件显式路径。必须绝对路径 + 普通文件 + 通过 `--version` 探测；无效显式路径 fail-closed（`VALIDATION_ERROR`，不静默回退）。未设置时，每进程对 `PATH` 上的 `fd` / `fdfind` 探测一次；都不存在则静默使用原生搜索。 |

## 下载与归档

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_SSRF_MODE` | 各 surface 默认 | `deny-private` / `allow-private`。未设置：`download_file` 用 `deny-private`（loopback/私有/链路本地/元数据目标被拦截，含 `169.254.169.254`），`network_info` 用 `allow-private`（诊断不受影响）。显式值对两个 surface 同时生效。禁止地址（未指定/组播/保留段）始终拦截。从不使用代理环境变量。 |
| `MCP_DOWNLOAD_MAX_BYTES` | `104857600` | 每次下载实际接收的最大字节数（100 MiB）；跨重试共享。超出即中止流并删除 staging 文件。 |
| `MCP_DOWNLOAD_TIMEOUT_MS` | `120000` | 下载绝对截止时间（覆盖整条重定向链与重试）。 |
| `MCP_DOWNLOAD_MAX_REDIRECTS` | `5` | 最大重定向跳数；每一跳都按 SSRF 策略重新解析、重新校验。 |
| `MCP_ARCHIVE_MAX_MEMBERS` | `10000` | 解压清单与压缩源预遍历的最大归档成员数。 |
| `MCP_ARCHIVE_MAX_MEMBER_BYTES` | `268435456` | 单个归档成员的最大展开字节数（256 MiB）；对清单与实际解压流双重执行。 |
| `MCP_ARCHIVE_MAX_EXPANDED_BYTES` | `1073741824` | 单次解压的最大展开字节总量（1 GiB）；双重执行（清单预检 + 实时计数）。 |
| `MCP_ARCHIVE_MAX_INPUT_BYTES` | `1073741824` | `compress_archive` 的最大源字节总量（1 GiB）；在启动压缩器前拒绝。 |
| `MCP_ARCHIVE_MAX_RATIO` | `200` | 最大展开/压缩比，只对展开超过 64 MiB 的成员生效（zip 炸弹防护）。 |

## 响应与工具面

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_RESPONSE_MAX_BYTES` | `2097152` | 序列化工具响应的硬上限（文本内容 + 结构化内容，UTF-8 字节）。超长的成功响应降级为 `RESOURCE_LIMIT` 错误信封；无效值回退默认并警告。没有不限制的设置。 |
| `ENHANCED_TERMINAL_DISABLE_FILE_INFO` | — | 设为 `1` 禁用 `file_info` 工具；工具面从 27 降到 26。横幅、`health://status`（`tools.enabled/disabled`）与 usage-guide prompt 报告与 `tools/list` 相同的启用数。 |

## 配置档

常见场景可直接抄的 `env` 块。背后的安全语义见[安全模型与配置档](./safety.zh-CN.md)。

**自己机器上的个人 agent（顺畅）：**

```json
"env": {
  "MCP_SAFETY_MODE": "off",
  "MCP_COMMAND_CONFIRMATION": "risk-gated"
}
```

**共享或 CI 环境（确认式）：**

```json
"env": {
  "MCP_SAFETY_MODE": "normal",
  "MCP_COMMAND_CONFIRMATION": "all",
  "MCP_AUDIT_MODE": "all"
}
```

**锁定主机（白名单）：**

```json
"env": {
  "MCP_SAFETY_MODE": "strict",
  "MCP_COMMAND_POLICY": "allow",
  "MCP_COMMAND_ALLOW": "git,node,npm,pnpm"
}
```
