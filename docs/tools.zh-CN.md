# 工具参考

[English](./tools.md)

> 本文为英文 `tools.md` 的中文翻译版；如有出入，以英文版为准。

27 个工具（设置 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时为 26 个），已与服务端实时 `tools/list` 输出核对。你客户端的 `tools/list` 始终是最终权威；本页补充 schema 看不到的契约与说明。

分类：[命令](#命令工具) · [文件](#文件工具) · [文件管理](#文件管理) · [搜索](#搜索工具) · [系统](#系统工具) · [归档与下载](#归档与下载工具) · [实用](#实用工具) · [资源](#资源) · [Prompts](#prompts)

## 通用契约

### 命令输出信封与分页

`execute_command`、`batch_execute`、`watch_command` 返回机器可读的信封：`ok`、`stdout`、`stderr`、`exit_code`、`timed_out`、`cancelled`、`truncated`、字节计数（stdout/stderr 的 `total/retained`）与 `paged`。

- 输出不超过 `MCP_COMMAND_MEMORY_OUTPUT_BYTES`（默认 1 MiB）时保留在内存。
- 超过后输出溢出到 `<state-dir>/temp` 下的按字节索引 page cache，信封报告 `paged: true`，结构化内容携带 `cache_id` 与分页元数据。
- **不必重新执行**即可读后续页：带 `cache_id`（加 `page` / `pageSize`）调用 `execute_command`。cache 模式拒绝 `command`、`cwd`、`timeout`；command 模式拒绝 `page`。`command` / `cache_id` 必须二选一。
- 绝对捕获上限：`MCP_COMMAND_MAX_OUTPUT_BYTES`（默认 50 MiB），超过后结果标记 `truncated`。

### partial-result 契约（搜索与列表）

`search_files`、`everything_search`、`grep_content`、`list_directory` 会报告：

- `complete`——遍历/读取错误被跳过时为 `false`；
- `warnings`——有界的结构化警告码；
- `truncated`——触及预算（`max_results` / 深度）。

Partial（`complete: false`）结果永不缓存。

### 错误信封

失败返回结构化错误，携带 31 个错误码之一（`PATH_TRAVERSAL`、`COMMAND_DANGEROUS`、`SAFETY_BLOCKED`、`ELICITATION_REQUIRED`、`SSRF_BLOCKED`、`ARCHIVE_LIMIT`、`RESOURCE_LIMIT`、`CANCELLED`……）以及 `retryable`、`suggestion`、`param` 提示，模型可据此自我修正。完整枚举在 `src/result.ts`，以它为权威。

### 结果缓存

只读结果缓存在进程内 LRU（128 条、滑动 TTL、约 32 MB 上限）：`read_file` 30s · `list_directory` 5s · `file_info` 30s · `search_files` 30s · `grep_content` 30s · `get_system_info` 60s。用 `cache_stats` / `cache_invalidate` 查看或清空。含已检出秘密的结果与 partial 结果永不缓存。

### 搜索平台行为

| 平台 | `search_files` 引擎 | 解析链 |
|------|---------------------|--------|
| Windows | Everything（`es.exe`，需自备）→ 原生回退 | `ENHANCED_TERMINAL_ES_PATH` → `<state-dir>/tools/es.exe` → 不可用 |
| Linux / macOS | 有 `fd` 时用 `fd` → 原生回退 | `ENHANCED_TERMINAL_FD_PATH`（fail-closed）→ `PATH` 上的 `fd`/`fdfind` → 不可用 |

运行期绝不下载任何东西。详情见[平台说明](../README.zh-CN.md#平台说明)。

## 命令工具

受安全层保护（`strict` 拦截；`normal` 确认；见[安全模型](./safety.zh-CN.md)）。经令牌桶限流（10 req/s；`MCP_BATCH_RATE_MODE` 控制一批消耗一个令牌还是每条命令各消耗一个）。

### `execute_command`

执行单条 shell/终端命令。返回带退出码与 stderr 的结构化结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 否 | 要执行的命令。未提供 cache_id 时必填。 |
| `cache_id` | string | 否 | 读取之前分页命令输出的某一页，不重新执行。 |
| `cwd` | string | 否 | 工作目录（可选） |
| `timeout` | integer | 否 | 超时（毫秒），默认 30000（最小 1，最大 3600000） |
| `page` | integer | 否 | 读取分页输出的页码，默认 1（最小 1） |
| `pageSize` | integer | 否 | 每页字符数，默认 2000，最大 10000（最小 1，最大 10000） |

### `batch_execute`

顺序执行多条命令。stop_on_error 为 true（默认）时遇到第一个错误即停。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `commands` | array | **是** | 要执行的命令数组 |
| `cwd` | string | 否 | 工作目录 |
| `stop_on_error` | boolean | 否 | 某条命令失败时是否停止，默认 true |
| `parallel` | boolean | 否 | 并行执行命令（无依赖时），默认 false——并行运行并发度为 4 |

### `watch_command`

执行命令并在限定时长内捕获输出。适合实时监控；非零退出即失败。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | **是** | 要运行的命令 |
| `duration` | integer | 否 | 最大时长（毫秒），默认 5000（最小 1，最大 600000） |
| `cwd` | string | 否 | 工作目录 |

## 文件工具

### `read_file`

读取文件内容。支持 offset/lines 分页。缓存 30s。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | **是** | 文件绝对路径 |
| `encoding` | string | 否 | 编码，默认 utf-8（自动检测） |
| `offset` | number | 否 | 起始行号（1 起算），默认 1 |
| `lines` | number | 否 | 最大读取行数，0 = 全部 |

### `write_file`

写内容到文件（按需创建父目录）。受安全层保护；秘密扫描拦截凭据写入。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | **是** | 文件绝对路径 |
| `content` | string | **是** | 要写的内容 |
| `append` | boolean | 否 | 追加而非覆盖，默认 false |

### `list_directory`

列出路径下的文件与目录（含详情）。带符号链接环保护；适用 partial-result 契约。缓存 5s。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dir_path` | string | **是** | 目录绝对路径 |
| `recursive` | boolean | 否 | 递归列出，默认 false |
| `max_depth` | integer | 否 | 递归时的最大深度，默认 3（最小 1，最大 32） |

### `file_info`

获取文件或目录的详细信息（大小、类型、时间戳）。缓存 30s。可通过 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 移出工具面。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target_path` | string | **是** | 文件或目录绝对路径 |

### `make_directory`

创建目录（含父目录）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dir_path` | string | **是** | 要创建的目录绝对路径 |

## 文件管理

两个工具都受安全层保护。

### `copy_move`

把文件/目录复制或移动到新位置。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source` | string | **是** | 源路径 |
| `destination` | string | **是** | 目标路径 |
| `operation` | enum(`copy` \| `move`) | **是** | 操作：复制或移动 |

### `delete_path`

删除文件或目录（谨慎使用！）。非空目录需要 `recursive: true`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `target_path` | string | **是** | 要删除的路径 |
| `recursive` | boolean | 否 | 递归删除目录，默认 false |

## 搜索工具

平台行为矩阵见[上文](#搜索平台行为)。三者都适用 partial-result 契约。

### `search_files`

按名称模式搜索文件。Windows 上用 Everything 引擎即时出结果（`es.exe` 需自备），Linux/macOS 上可用时用 fd，否则回退原生搜索。缓存 30s。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dir_path` | string | **是** | 搜索目录 |
| `pattern` | string | **是** | 文件名模式，如 *.ts、*.log、test* |
| `max_depth` | integer | 否 | 原生回退的最大搜索深度，默认 5；引擎路径（Everything/fd）未显式设置时搜索全树（最小 1，最大 32） |
| `max_results` | integer | 否 | 最大结果数，默认 50（最小 1，最大 500） |

### `everything_search`

由 Everything 引擎驱动的超快全盘文件搜索（仅 Windows）。Everything 不可用时返回结构化安装详情，而不是伪装成空结果。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | string | **是** | Everything 搜索查询。支持：通配符(*.txt)、正则、path:、size:、date: 过滤器 |
| `dir_filter` | string | 否 | 可选：把搜索限制在该目录路径内 |
| `max_results` | integer | 否 | 最大结果数，默认 100（最小 1，最大 1000） |

### `grep_content`

按正则搜索文件内容。Windows 用 PowerShell Select-String，Unix 用 grep。缓存 30s。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `dir_path` | string | **是** | 搜索目录 |
| `pattern` | string | **是** | 在文件内容中搜索的正则 |
| `file_pattern` | string | 否 | 文件名过滤，如 *.ts，默认 * |
| `max_results` | integer | 否 | 最大匹配行数，默认 50（最小 1，最大 500） |

## 系统工具

### `get_system_info`

获取详细系统信息（OS、CPU、内存、磁盘、GPU 等）。缓存 60s。无参数。

### `process_list`

列出运行中的进程，可按名称过滤。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filter` | string | 否 | 按名称过滤进程 |
| `top` | integer | 否 | 按内存展示前 N 个进程，默认 20（最小 1，最大 100） |

### `kill_process`

按 PID 或名称终止进程（`pid` 或 `name`，二选一必填）。拒绝终止关键系统进程。受安全层保护。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `pid` | integer | 否 | 要终止的进程 ID（最小 1，最大 2147483647） |
| `name` | string | 否 | 要终止的进程基名（精确匹配） |
| `force` | boolean | 否 | 强制终止，默认 false |

### `network_info`

获取网络配置与连通性信息。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum(`config` \| `connections` \| `ping` \| `dns`) | 否 | 操作：config、connections、ping、dns。默认 config |
| `target` | string | 否 | 目标主机（ping/dns 必填） |

### `environment_vars`

获取或列出环境变量（敏感键隐藏；值展示由 `MCP_ENV_VALUE_MODE` 管控）。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum(`get` \| `list`) | **是** | get = 取单个变量，list = 列出全部 |
| `name` | string | 否 | 变量名（get 必填） |

## 归档与下载工具

三个工具都受安全层保护。预算（成员数、展开字节、压缩比、下载大小/截止/重定向）在[配置](./configuration.zh-CN.md#下载与归档)中设置。

### `compress_archive`

把文件/目录压缩为 zip 归档。Linux/macOS 上调用系统 `zip` 二进制。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source_path` | string | **是** | 要压缩的文件或目录路径 |
| `output_path` | string | **是** | 输出 zip 文件路径 |

### `extract_archive`

解压 zip 归档到目录（成员校验、体积预算、staging 解压）。Linux/macOS 上调用 `unzip`。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `archive_path` | string | **是** | zip 文件路径 |
| `output_dir` | string | **是** | 解压目标目录 |

### `download_file`

从 HTTP/HTTPS URL 下载文件到本地路径。私有/loopback/元数据目标被 SSRF 策略拦截（`MCP_SSRF_MODE=allow-private` 可放行），重定向逐跳重新校验，适用大小/截止预算。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | **是** | 下载 URL（http/https，不带凭据） |
| `save_path` | string | **是** | 保存文件的本地路径 |

## 实用工具

### `telemetry_report`

获取工具调用指标：按工具的延迟、错误率、缓存命中率。用于排查性能问题。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `recent` | number | 否 | 展示最近 N 次调用，默认 20 |

### `cache_stats`

获取 LRU 缓存统计：大小、命中率、容量。用于了解缓存效果。无参数。

### `cache_invalidate`

清空全部或指定工具缓存。结果变陈旧时使用。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tool` | string | 否 | 只清空指定工具的缓存；省略则全部清空 |

### `session_state`

查看或修改会话状态：工作目录、环境变量。会话 env 作用于命令工具；持久化由 `MCP_SESSION_PERSIST_ENV_VALUES` 管控。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `action` | enum(`get` \| `set_cwd` \| `set_env` \| `reset`) | **是** | get=查看状态，set_cwd=改工作目录，set_env=设 env 变量，reset=清空会话 |
| `cwd` | string | 否 | 新工作目录（set_cwd 必填） |
| `key` | string | 否 | env 变量名（set_env 必填） |
| `value` | string | 否 | env 变量值（set_env 必填；可为空字符串） |

### `pool_stats`

Shell 进程池统计。当前无激活（执行使用按需 spawnStream）；size/idle/busy 恒为 0，max 是为未来池预留的容量。无参数。

### `temp_stats`

获取临时资源统计：目录总数、大小、最老/最新年龄、移除计数。无参数。

## 资源

- `health://status` — JSON 健康检查，含版本、指标、缓存、会话、临时资源与审计信息。`status` 为 `healthy` / `degraded` / `failed`，由四个组件聚合（审计写入、临时容量、进程监管、会话持久化）。以直读模板注册：**不出现在** `resources/list` 中，但直接读 URI 有效。
- `audit://log` — 最近的审计条目（默认限制：50）。`audit://log?limit=N` 请求指定限制（钳制到 1–1000）。

## Prompts

- `usage-guide` — 工具概览，注入实时会话上下文。
- `safety-info` — 当前安全配置（模式、Elicitation 支持、工具数、缓存统计）。
