# Enhanced Terminal MCP 架构总入口

> 状态：current
> 创建日期：2026-08-16（由 `cs-arch backfill` 按 v3.1.0 代码现状补全）
> 最后核对：2026-08-16

## 1. 项目简介

Enhanced Terminal MCP v3.1.0 是一个基于 TypeScript / Node.js 的 MCP server，通过 stdio 传输协议向 AI 客户端提供 **26 个工具**（命令执行、文件 I/O、文件管理、搜索、系统、归档、运维遥测 7 类）、1 个 `health://status` 资源、2 个 prompt（`usage-guide` / `safety-info`）。

- 包入口：`build/index.js`（`src/index.ts` 编译产物）
- 依赖：`@modelcontextprotocol/sdk` 1.26（patch-package 修补）、`zod` 3
- 主要消费方：Claude Desktop / Cherry Studio 等 MCP 客户端

## 2. 核心概念 / 术语表

| 术语 | 含义 |
|------|------|
| Tool / registerTool | 每个能力一个 MCP 工具，Zod `inputSchema` + `outputSchema` + `annotations` |
| wrapHandler | 统一 handler 包装器：自动 telemetry 采集 + LRU 缓存命中/写入 |
| ToolResult | 统一结果协议 `{ok, content, structured, meta}` 或 `{ok:false, error}` |
| StructuredError | 18 个错误码 + `retryable` / `suggestion` / `param` / `detail` 提示 |
| SafeGuard | 三级安全策略引擎（strict / normal / off），normal 下走 MCP Elicitation 确认 |
| 硬性底线 | `security.ts` 的路径/命令/URL 校验，任何安全模式下都生效 |
| CommandSpec | 跨平台命令规格 `{file, args, useShell?}`，供 `execFile` 参数化执行 |
| ShellSpec / ShellInvocation | `shell.ts` 的解析产物与 spawn 调用构造 `{file, flavor, source, version?}`；Windows 一次性解析、进程级缓存 |
| spawnStream | spawn 流式执行器，替代 `exec` 全量缓冲 |
| SessionStore | cwd / 自定义 env / 命令历史，持久化到临时目录 JSON |
| ProcessPool | 预热的 shell 子进程池（当前无工具调用 `acquire()`，见 ADR-13） |
| LRU 结果缓存 | 128 条上限、30s 默认 TTL 的工具级结果缓存 |
| TelemetryStore | 工具调用延迟/错误率/缓存命中率指标聚合 |

## 3. 子系统 / 模块索引

### 3.1 入口与工具层

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 入口：创建 McpServer → initSafeGuard → 注册 21 个业务工具 + 5 个运维工具 → 注册资源/prompts → 连接 stdio → 优雅退出 |
| `src/tools/command.ts` | `execute_command` / `batch_execute` / `watch_command`。Windows 消费 `shell.ts` 统一解析的 shell spec（默认 pwsh 7，详见 ADR-7/14），Unix 用 `/bin/sh -c`；危险模式检查 + 限流 + SafeGuard + `spawnStream` |
| `src/tools/files.ts` | `read_file`（分页/编码）/ `write_file`（秘密扫描 + 覆写确认）/ `list_directory`（符号链接循环保护）/ `file_info`（可被 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 禁用）/ `make_directory` |
| `src/tools/manage.ts` | `copy_move` / `delete_path`（递归删除需 `recursive=true` + 确认） |
| `src/tools/search.ts` | `search_files`（Everything `es.exe` 优先，原生递归兜底）/ `everything_search`（仅 Windows）/ `grep_content`（解析为 pwsh/powershell flavor 时走统一 spec 的 Select-String → Unix grep → 原生三级降级；参数单引号内联转义） |
| `src/tools/system.ts` | `get_system_info` / `process_list` / `kill_process`（关键进程保护）/ `network_info` / `environment_vars`（敏感键打码） |
| `src/tools/archive.ts` | `compress_archive` / `extract_archive`（Windows 走 PowerShell Compress/Expand-Archive）/ `download_file`（HTTP/HTTPS 白名单 + 指数退避重试） |

### 3.2 横切基础层

| 模块 | 职责 |
|------|------|
| `src/security.ts` | 路径穿越（含 URL 多重编码绕过）、系统目录黑名单、敏感文件/目录模式、危险命令正则（2026-08-16 powershell-default-shell 起含 PowerShell `-EncodedCommand`/`iex`/`Start-Process`/`Stop-Computer`/`Set-ExecutionPolicy`/盘符根递归删除）、URL 协议白名单、主机名校验、进程名消毒 |
| `src/safeguard.ts` | strict 禁用 6 个破坏性工具；normal 对 delete/write/kill 走 Elicitation；关键进程黑名单全模式生效 |
| `src/result.ts` | ToolResult 协议、18 错误码、`fail`/`success` 工厂、MCP `CallToolResult` 转换 |
| `src/wrap.ts` | handler 包装：telemetry 记录 + 缓存命中/回填 |
| `src/cache.ts` | LRU 实现 + `CACHEABLE_TOOLS`（7 个只读工具）+ 工具级 TTL + 按前缀/路径失效 |
| `src/telemetry.ts` | 指标环形历史（1000 条）+ 按工具聚合 + 全局 summary |
| `src/session.ts` | cwd/env/history 管理，5s 去抖持久化到 `%TEMP%\.enhanced-terminal-mcp-session.json` |
| `src/shell.ts` | Windows shell 解析与调用构造的唯一归属：`resolveShell`（纯选择逻辑，候选可注入）→ `getShellSpec`（进程级缓存，成败皆缓存）→ `buildShellInvocation`（唯一 flavor→参数/编码转换入口，pwsh 7 与 5.1 统一加 UTF-8 preamble，cmd 保留 chcp）；另提供 `powerShellTarget`（平台 spec 的 PS 目标适配，cmd 兼容档回退 powershell.exe）与旧 `getShell`/`wrapCommand` 兼容导出 |
| `src/stream.ts` | `spawnStream`：stdout 10MB 上限、stderr 1MB 上限、超时 SIGTERM→SIGKILL；`quickExec` |
| `src/pool.ts` | shell 预热池（4 进程 / 60s 空闲回收），惰性创建；shell 构造已惰性同步统一 shell spec（首次 acquire 触发），仍未接入生产命令链 |
| `src/platform.ts` | 平台判定 + `getShell`/`wrapCommand` + 各类 `get*Spec` 跨平台命令构造 |
| `src/adaptive.ts` | 自适应超时（历史 avg×3，上限 4× 默认）+ `withRetry` 指数退避 |
| `src/ratelimit.ts` | TokenBucket（10 req/s，burst 20）；`checkRateLimit` |
| `src/utils.ts` | `safeExec`（shell 执行）/ `safeExecFile`（参数化执行）/ `smartDecode`（UTF-8→GBK 回退）/ `formatSize` |
| `src/scan.ts` | write_file 前扫描 OpenAI/GitHub/AWS/JWT/Slack/连接串等 10 类凭据 |
| `src/regex.ts` | 正则编译缓存 + 基础 ReDoS 拒绝 |
| `src/context.ts` | 会话上下文注入（**当前未被生产代码使用**，仅测试覆盖） |
| `src/logger.ts` | 分级结构化日志（写 stderr，`MCP_LOG_LEVEL` 控制） |

### 3.3 外部资产

| 路径 | 说明 |
|------|------|
| `es_tool/es.exe` | 捆绑的 Everything CLI（Windows 全盘索引搜索，`search_files` 首选路径） |
| `scripts/ensure-pwsh.ps1` | 便携 pwsh 7 bootstrap（纯 ASCII——PS 5.1 会把无 BOM UTF-8 按 GBK 误解析），仅 `setup.bat` 显式触发 |
| `tools/pwsh/` | bootstrap 安装的便携 pwsh 7（`.version` 版本标记；与 `tools/.pwsh-staging/` 一并被 gitignore） |
| `patches/@modelcontextprotocol+sdk+1.26.0.patch` | patch-package：SDK 生成的 JSON Schema 保证 `required` 为显式数组 |
| `build/` | tsc 产物（含部分历史遗留文件，如 `middleware.*`，src 中已不存在） |

## 4. 关键架构决定

- **ADR-1 stdio 单传输**：`StdioServerTransport`，每客户端一进程；所有日志走 stderr 避免污染协议流。
- **ADR-2 全部工具带类型化 schema**：Zod `inputSchema` + `outputSchema` + `annotations`（readOnly/destructive/idempotent hints），输出同时给人类文本和 `structuredContent`。
- **ADR-3 统一结果协议**：所有 handler 返回 `ToolResult`，错误统一 18 个错误码并携带 LLM 可决策的 `retryable/suggestion/param`。
- **ADR-4 中间件化横切**：`wrapHandler` 统一做 telemetry 和缓存，handler 本体不感知。
- **ADR-5 安全双层**：`security.ts` 硬性底线（任何模式生效）+ `safeguard.ts` 策略层（strict/normal/off + Elicitation）；危险命令正则、关键进程保护属于硬底线。
- **ADR-6 跨平台 CommandSpec**：能参数化的系统命令一律 `execFile(file, args)`；需要 shell 特性的才走 shell，并限制在上游已校验的输入。
- **ADR-7 Windows 默认 PowerShell（2026-08-16 powershell-default-shell 起取代旧 cmd 方案）**：命令工具与平台 spec 统一消费 `shell.ts` 解析的 shell spec。默认 `MCP_SHELL=pwsh`，按「`MCP_POWERSHELL_PATH` 显式路径（fail closed）→ 项目便携 pwsh 7（`tools/pwsh`）→ PATH pwsh → Windows PowerShell 5.1 回退」一次解析、进程级缓存（成败皆缓存，改配置/装 pwsh 需重启）；`MCP_SHELL=cmd|powershell` 为兼容档（cmd 档下 PS 类平台 spec 回退 powershell.exe 保持 v3.1 行为）；Unix 不进入该流程仍 `/bin/sh`。中文 Windows 实测 pwsh 7 管道输出同为 GBK，故 invocation 层对 pwsh 7 与 5.1 统一加 UTF-8 preamble。
- **ADR-8 流式执行**：命令执行统一 `spawnStream`，输出超 10MB 截断并终止；超时先 SIGTERM，2s 后 SIGKILL。
- **ADR-9 只缓存幂等只读工具**：`CACHEABLE_TOOLS` 白名单 7 个工具；默认 TTL 30s，目录 5s、系统信息 60s；写操作按路径失效相关缓存。
- **ADR-10 会话持久化**：cwd/env/history 存 `%TEMP%/.enhanced-terminal-mcp-session.json`，5s 去抖写盘，重启恢复。
- **ADR-11 Windows 搜索捆绑 Everything**：`es_tool/es.exe` 随包分发，10s 超时兜底原生递归搜索。
- **ADR-12 patch-package 修 SDK**：SDK 输出 schema 缺 `required` 数组会让严格校验器（OpenAI/DeepSeek 等）失败，用 patch 保证显式 `required: []`。
- **ADR-13 进程池暂未接入执行链**：`processPool` 提供 acquire/release/stats，但命令工具实际走 `spawnStream` 按需 spawn；池当前只用于统计面板和清扫定时器，属预留能力（shell 构造已惰性同步统一 spec，见 ADR-7）。
- **ADR-14 bootstrap 可联网、运行期绝不联网**：便携 pwsh 7 由 `setup.bat → scripts/ensure-pwsh.ps1` 显式安装——固定版本（7.6.5）+ 官方 SHA256 + 仓库内 `tools/.pwsh-staging` 原子替换；`tools/pwsh`、staging 均不入 Git。MCP server 运行路径零网络依赖，未找到候选 shell 时返回结构化错误（`INVALID_SHELL_MODE` / `SHELL_PATH_INVALID` / `SHELL_NOT_FOUND`）。

## 5. 已知约束 / 硬边界

### 运行环境
- Node.js ≥ 18；ESM（`"type": "module"`）；tsc 输出 `build/`，`rootDir: src`。
- 支持 Windows / macOS / Linux；`everything_search` 与 Everything 加速仅 Windows。
- shell 相关环境变量（2026-08-16 powershell-default-shell 起，仅 Windows 生效）：`MCP_SHELL`（默认 `pwsh`，可选 `powershell` / `cmd`）、`MCP_POWERSHELL_PATH`（显式执行器路径，无效即硬失败）；解析结果进程级缓存，修改后需重启。

### 安全硬边界（任何 `MCP_SAFETY_MODE` 下生效）
- Windows 禁止路径：`C:\Windows`、`Program Files` 等 9 个系统目录；Unix：`/etc`、`/proc` 等 11 个。
- 路径含 `..` 段或 URL 编码穿越（含多重编码）一律拒绝。
- 敏感文件（`.env`、SSH 密钥、`kubeconfig` 等）与敏感目录（`.ssh`/`.aws`/`.kube` 等）拒绝读写。
- 危险命令黑名单硬拦；关键进程（csrss/svchost/explorer 等）禁止 kill。
- URL 仅 `http/https`；主机名仅 `[a-zA-Z0-9.\-:]`。

### 资源上限
- stdout 10MB、stderr 1MB；`execute_command` 文本结果截断 2000 字符，错误摘要截断 500 字符。
- 缓存 128 条 / 30s（目录 5s、系统信息 60s）。
- 命令限流 10 req/s（burst 20），当前只接入 `execute_command`。
- 默认超时：execute 30s（自适应 P95×3，上限 4×）、batch 每步 30s、watch 5s、下载 120s 等，见 `adaptive.ts`。

### 测试与覆盖策略
- 单测覆盖 `src/**` 基础层；`src/tools/**` 与 `src/index.ts` 从覆盖率排除——工具处理器由 `tests/e2e-latency.test.ts` 子进程 e2e 覆盖（vitest 无法收集子进程覆盖率）。
- 当前基线：35 个测试文件 / 543 用例全绿；e2e 24 项延迟阈值全部达标。
