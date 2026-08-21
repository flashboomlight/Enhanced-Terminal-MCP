# Enhanced Terminal MCP 架构总入口

> 状态：current
> 创建日期：2026-08-16（由 `cs-arch backfill` 按 v3.1.0 代码现状补全）
> 最后核对：2026-08-21（合并基线已落地；M2 处于部分实现状态，最终 A+ 契约仍归 M4 收口）

## 1. 项目简介

Enhanced Terminal MCP v3.1.0 是一个基于 TypeScript / Node.js 的 MCP server，通过 stdio 传输协议向 AI 客户端提供 **27 个工具**（默认；`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时 26 个；命令执行、文件 I/O、文件管理、搜索、系统、归档、运维遥测 7 类）、1 个 `health://status` 资源、2 个 prompt（`usage-guide` / `safety-info`）。

- 包入口：`build/index.js`（`src/index.ts` 编译产物）
- 依赖：`@modelcontextprotocol/sdk` 1.29（精确 + overrides；postinstall 零依赖补丁脚本）、`zod` 3
- 主要消费方：Claude Desktop / Cherry Studio 等 MCP 客户端

## 2. 核心概念 / 术语表

| 术语 | 含义 |
|------|------|
| Tool / registerTool | 每个能力一个 MCP 工具，Zod `inputSchema` + `outputSchema` + `annotations`；工具数量由 `getRegisteredToolCount()` 动态统计 |
| wrapHandler | 统一 handler 包装器：自动 telemetry 采集 + LRU 缓存命中/写入 |
| ToolResult | 统一结果协议 `{ok, content, structured, meta}` 或 `{ok:false, error}` |
| StructuredError | 19 个错误码 + `retryable` / `suggestion` / `param` / `detail` 提示；M2 计划新增的 `SECRET_DETECTED` 尚未进入当前代码 |
| SafeGuard | 三级安全策略引擎（strict / normal / off），normal 下走 MCP Elicitation 确认 |
| hardBlock | 不可关闭的灾难性命令硬底线（所有安全模式含 off 均生效） |
| 硬性底线 | `security.ts` 的路径/命令/URL 校验，任何安全模式下都生效 |
| CommandSpec | 跨平台命令规格 `{file, args, useShell?}`，供 `execFile` 参数化执行 |
| ShellSpec / ShellInvocation | `shell.ts` 的解析产物与 spawn 调用构造 `{file, flavor, source, version?}`；Windows 一次性解析、进程级缓存 |
| spawnStream | 既有 spawn 流式执行器，供 `safeExec` / `quickExec` 等消费者使用 |
| CommandOutputRuntime | `capture.ts` + `command-output.ts` 的共享原始字节捕获、actual 计数、backpressure/drain、内存 retention 和流式 secret matcher；当前尚未接通 staging writer |
| SessionStore | cwd / 自定义 env / 命令历史，持久化到 `<projectRoot>/.etmcp/session.json`；恢复时校验 cwd 与 env 黑名单 |
| Audit Log | 结构化审计日志（JSON Lines），按 `MCP_AUDIT_MODE` 控制写入 |
| Temp Manager | 临时资源生命周期管理器（懒创建 root、reservation、staging heartbeat、TTL + LRU） |
| Page Cache | 当前仍为 `paging.ts` 的 legacy 文本分页缓存；A+ 二进制字符索引与范围读取尚未落地 |
| ProcessPool | 预热的 shell 子进程池；**当前为 E 的 inactive stub，`pool_stats` 恒 `active:false`**，实际执行走 `spawnStream` |
| LRU 结果缓存 | 128 条上限、30s 默认 TTL 的工具级结果缓存 |
| TelemetryStore | 工具调用延迟/错误率/缓存命中率指标聚合 |

## 3. 子系统 / 模块索引

### 3.1 入口与工具层

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 入口：创建 McpServer → initSafeGuard → 注册业务工具 + 运维工具 → 注册资源/prompts → 连接 stdio → 优雅退出 |
| `src/tools/command.ts` | `execute_command` / `batch_execute` / `watch_command`。Windows 消费 `shell.ts` 统一解析的 shell spec（默认 pwsh 7，详见 ADR-7/14），Unix 用 `/bin/sh -c`；命令 policy + 危险模式检查 + 限流 + SafeGuard + audit 后调用共享 `runCommandOutput`。公开输入输出仍是 M2 之前的 legacy 契约 |
| `src/tools/files.ts` | `read_file`（分页/编码）/ `write_file`（秘密扫描 + 覆写确认）/ `list_directory`（符号链接循环保护）/ `file_info`（可被 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 禁用）/ `make_directory` |
| `src/tools/manage.ts` | `copy_move` / `delete_path`（递归删除需 `recursive=true` + 确认） |
| `src/tools/search.ts` | `search_files`（Everything `es.exe` 优先，原生递归兜底）/ `everything_search`（仅 Windows）/ `grep_content`（解析为 pwsh/powershell flavor 时走统一 spec 的 Select-String → Unix grep → 原生三级降级；参数单引号内联转义） |
| `src/tools/system.ts` | `get_system_info` / `process_list` / `kill_process`（关键进程保护）/ `network_info` / `environment_vars`（敏感键打码） |
| `src/tools/archive.ts` | `compress_archive` / `extract_archive`（Windows 走 PowerShell Compress/Expand-Archive）/ `download_file`（HTTP/HTTPS 白名单 + 指数退避重试） |
| `src/tools/utility.ts` | `telemetry_report` / `cache_stats` / `session_state` / `pool_stats` / `temp_stats` 等运维工具 |

### 3.2 横切基础层

| 模块 | 职责 |
|------|------|
| `src/security.ts` | 路径穿越（含 URL 多重编码绕过）、系统目录黑名单、敏感文件/目录模式、危险命令正则（D 的 PowerShell `-EncodedCommand`/`iex`/`Start-Process`/`Stop-Computer`/`Set-ExecutionPolicy`/盘符根递归删除 + E 的间接执行/解释器/管道绕过规则的并集）、URL 协议白名单、主机名校验、进程名消毒 |
| `src/command-policy.ts` | 命令策略统一入口：`blocklist`（默认）/ `allow`（词级白名单 + 禁止 shell 元字符/管道/嵌套 shell）；hardBlock 永远先执行 |
| `src/safeguard.ts` | strict 禁用 6 个破坏性工具；normal 对 delete/write/kill 走 Elicitation；关键进程黑名单全模式生效 |
| `src/result.ts` | ToolResult 协议、19 错误码、`fail`/`success` 工厂、MCP `CallToolResult` 转换；命令类 A+ envelope 与 `SECRET_DETECTED` 尚未接通 |
| `src/wrap.ts` | handler 包装：telemetry 记录 + 缓存命中/回填 |
| `src/cache.ts` | LRU 实现 + `CACHEABLE_TOOLS`（7 个只读工具）+ 工具级 TTL + 按前缀/路径失效 |
| `src/telemetry.ts` | 指标环形历史（1000 条）+ 按工具聚合 + 全局 summary |
| `src/session.ts` | cwd/env/history 管理，去抖持久化到 `<projectRoot>/.etmcp/session.json`；恢复消毒 |
| `src/state-dir.ts` | 统一状态目录解析：固定 `projectRoot`（`realpath(process.cwd())`，进程级不变）、默认 `<projectRoot>/.etmcp`、`MCP_STATE_DIR` 覆盖只解析一次；旧 `.enhanced-terminal-mcp` 迁移协议 |
| `src/audit.ts` | 结构化审计日志写入与读取（`<projectRoot>/.etmcp/logs/audit.jsonl`） |
| `src/temp-manager.ts` | 临时目录懒创建、reservation、同进程 mutex、跨进程短锁、staging heartbeat/恢复、TTL + LRU 回收和资源统计 |
| `src/paging.ts` | 当前 legacy `stdout.txt`/`stderr.txt`/`meta.json` 文本分页；读取会整体加载 stdout 并按字符串 `slice` |
| `src/capture.ts` | child lifecycle、stdout/stderr 原始 Buffer chunk、actual 字节计数、backpressure、drain、timeout 和消费失败处理 |
| `src/command-output.ts` | 三个命令工具共享的纯内存输出编排；当前包含 limits 校验、流式 matcher、quarantine/fallback 与双流抑制，spill/finalize 尚未接通 |
| `src/secret-registry.ts` / `src/secret-stream.ts` | whole-string registry 与流式 matcher 的单一 pattern 来源；固定 8192-byte quarantine 和 65536-byte fallback preview |
| `src/es-integrity.ts` | `es.exe` SHA-256 校验一致后才允许执行 |
| `src/shell.ts` | Windows shell 解析与调用构造的唯一归属：`resolveShell`（纯选择逻辑，候选可注入）→ `getShellSpec`（进程级缓存，成败皆缓存）→ `buildShellInvocation`（唯一 flavor→参数/编码转换入口，pwsh 7 与 5.1 统一加 UTF-8 preamble，cmd 保留 chcp）；另提供 `powerShellTarget`（平台 spec 的 PS 目标适配，cmd 兼容档回退 powershell.exe）与旧 `getShell`/`wrapCommand` 兼容导出 |
| `src/stream.ts` | 既有 `spawnStream`：stdout 10MB 上限、stderr 1MB 上限、超时 SIGTERM→SIGKILL；`quickExec`。三个命令工具的 M2 捕获路径改走 `capture.ts` |
| `src/pool.ts` | E 的 inactive stub（仅 stats / 生命周期钩子），`pool_stats` 固定 `active:false` |
| `src/platform.ts` | 平台判定 + `getShell`/`wrapCommand` 兼容再导出 + 各类 `get*Spec` 跨平台命令构造 |
| `src/adaptive.ts` | 自适应超时（历史 avg×3，上限 4× 默认）+ `withRetry` 指数退避 |
| `src/ratelimit.ts` | TokenBucket（10 req/s，burst 20）；`checkRateLimit` |
| `src/utils.ts` | `safeExec`（shell spec + spawnStream）/ `safeExecFile`（参数化执行）/ `envInt` / `formatSize` |
| `src/scan.ts` | write_file 前扫描 OpenAI/GitHub/AWS/JWT/Slack/连接串等 10 类凭据 |
| `src/regex.ts` | 正则编译缓存 + 基础 ReDoS 拒绝 |
| `src/context.ts` | 会话上下文注入（**当前未被生产代码使用**，仅测试覆盖） |
| `src/logger.ts` | 分级结构化日志（写 stderr，`MCP_LOG_LEVEL` 控制） |
| `src/version.ts` | 版本信息读取 |

### 3.3 外部资产

| 路径 | 说明 |
|------|------|
| `es_tool/es.exe` | 捆绑的 Everything CLI（Windows 全盘索引搜索，`search_files` 首选路径；SHA-256 锁定校验） |
| `scripts/ensure-pwsh.ps1` | 便携 pwsh 7 bootstrap（纯 ASCII——PS 5.1 会把无 BOM UTF-8 按 GBK 误解析），仅 `setup.bat` 显式触发 |
| `tools/pwsh/` | bootstrap 安装的便携 pwsh 7（`.version` 版本标记；与 `tools/.pwsh-staging/` 一并被 gitignore） |
| `scripts/apply-mcp-sdk-patch.mjs` | postinstall 零依赖 SDK 补丁脚本；`patch-package` 仅 devDependency |
| `patches/` | patch 开发参考 |
| `build/` | tsc 产物（含部分历史遗留文件，如 `middleware.*`，src 中已不存在） |

## 4. 状态目录结构

```
<projectRoot>/.etmcp/
├── session.json（session 首次持久化时按需创建）
├── logs/
│   └── audit.jsonl
└── temp/（仅首次真正需要临时资源时创建）
    └── page-cache-{timestamp}-{random}/（当前 legacy 分页布局）
        ├── .meta.json
        ├── stdout.txt
        ├── stderr.txt
        └── meta.json
```

- `projectRoot = realpath(process.cwd())`，server 启动时计算一次，进程生命周期内不变；`MCP_STATE_DIR` 相对路径只相对固定 `projectRoot` 解析一次。
- `.etmcp` 根可由 session/audit 按需创建；`temp` 及其 page-cache 子目录不会因为 server 启动、`temp_stats` 或 cleanup 自动创建。
- 旧 `<projectRoot>/.enhanced-terminal-mcp` 的 `session.json` 与 `logs/audit.jsonl` 按 roadmap 4.5 迁移协议自动迁移（排他锁、同卷 staging、原子替换、回读验证、失败报 `STATE_MIGRATION_FAILED`）；旧 `temp` 与未知文件永不迁移。
- 全局 `%TEMP%\.enhanced-terminal-mcp-session.json` 不自动导入或删除，发现时只记录不含内容/cwd/env 的提示。

## 5. 关键架构决定

- **ADR-1 stdio 单传输**：`StdioServerTransport`，每客户端一进程；所有日志走 stderr 避免污染协议流。
- **ADR-2 全部工具带类型化 schema**：Zod `inputSchema` + `outputSchema` + `annotations`（readOnly/destructive/idempotent hints），输出同时给人类文本和 `structuredContent`。
- **ADR-3 统一结果协议**：所有 handler 返回 `ToolResult`，错误统一 19 个错误码并携带 LLM 可决策的 `retryable/suggestion/param`；命令类 `SECRET_DETECTED` 与完整 A+ envelope 仍在 M2 实现中。
- **ADR-4 中间件化横切**：`wrapHandler` 统一做 telemetry 和缓存，handler 本体不感知。
- **ADR-5 安全双层**：`security.ts` 硬性底线（任何模式生效）+ `safeguard.ts` 策略层（strict/normal/off + Elicitation）；危险命令正则、关键进程保护属于硬底线。hardBlock 全模式（含 off）不可关闭。
- **ADR-6 跨平台 CommandSpec**：能参数化的系统命令一律 `execFile(file, args)`；需要 shell 特性的才走 shell，并限制在上游已校验的输入。
- **ADR-7 Windows 默认 PowerShell（2026-08-16 powershell-default-shell 起取代旧 cmd 方案）**：命令工具与平台 spec 统一消费 `shell.ts` 解析的 shell spec。默认 `MCP_SHELL=pwsh`，按「`MCP_POWERSHELL_PATH` 显式路径（fail closed）→ 项目便携 pwsh 7（`tools/pwsh`）→ PATH pwsh → Windows PowerShell 5.1 回退」一次解析、进程级缓存（成败皆缓存，改配置/装 pwsh 需重启）；`MCP_SHELL=cmd|powershell` 为兼容档（cmd 档下 PS 类平台 spec 回退 powershell.exe 保持 v3.1 行为）；Unix 不进入该流程仍 `/bin/sh`。中文 Windows 实测 pwsh 7 管道输出同为 GBK，故 invocation 层对 pwsh 7 与 5.1 统一加 UTF-8 preamble。
- **ADR-8 流式执行**：既有 `safeExec` / `quickExec` 继续使用 `spawnStream`（输出超上限截断并终止；超时先 SIGTERM，2s 后 SIGKILL）；`execute_command` / `batch_execute` / `watch_command` 已切换到 M2 的 `capture.ts` 共享捕获，输出超限当前只停止 retention 并继续 drain，公开成功/错误 envelope 仍待 M2 收口。
- **ADR-9 只缓存幂等只读工具**：`CACHEABLE_TOOLS` 白名单 7 个工具；默认 TTL 30s，目录 5s、系统信息 60s；写操作按路径失效相关缓存；含密钥扫描命中的内容不写入 LRU。
- **ADR-10 会话持久化**：cwd/env/history 存 `<projectRoot>/.etmcp/session.json`，去抖写盘，重启恢复并消毒（拒绝危险 env 键与非法 cwd）。
- **ADR-11 Windows 搜索捆绑 Everything**：当前 `es_tool/es.exe` 随包分发，执行前做 SHA-256 锁定校验，10s 超时兜底原生递归搜索；可选发布边界由 roadmap 的 M3 规划。
- **ADR-12 SDK 补丁**：SDK 输出 schema 缺 `required` 数组会让严格校验器（OpenAI/DeepSeek 等）失败；postinstall 零依赖脚本保证显式 `required: []`。
- **ADR-13 进程池未接入执行链**：merge 采用 E 的 inactive stub，`pool_stats` 固定 `active:false`；命令工具实际走 `spawnStream` 按需 spawn。
- **ADR-14 bootstrap 可联网、运行期绝不联网**：便携 pwsh 7 由 `setup.bat → scripts/ensure-pwsh.ps1` 显式安装——固定版本（7.6.5）+ 官方 SHA256 + 仓库内 `tools/.pwsh-staging` 原子替换；`tools/pwsh`、staging 均不入 Git。MCP server 运行路径零网络依赖，未找到候选 shell 时返回结构化错误（`INVALID_SHELL_MODE` / `SHELL_PATH_INVALID` / `SHELL_NOT_FOUND`）。
- **ADR-15 状态根固定 projectRoot**：默认状态目录 `<projectRoot>/.etmcp`，不随 `session_state set_cwd` 或单条命令 cwd 漂移；npm 包安装目录、源码目录、`build/` 目录不得作为默认状态根。
- **ADR-16 命令 policy**：`MCP_COMMAND_POLICY=blocklist`（默认）/ `allow`；allow 用词级可执行白名单并禁止 shell 元字符/管道/嵌套 shell，仍叠加 hardBlock；`batch_execute` 执行前全量预检，任一失败整批不部分执行。
- **ADR-17 M2 过渡状态（2026-08-21）**：三个命令工具共享 `runCommandOutput` 的原始字节捕获和内存 scanner；`src/paging.ts` 仍是 legacy 文本 cache，staging writer、page cache v2、`SECRET_DETECTED`、batch/watch/cache read A+ envelope 和阶段 C 门禁尚未完成。任何文档不得把这些目标态字段写成当前公开契约。

## 6. 已知约束 / 硬边界

### 运行环境
- Node.js ≥ 20；ESM（`"type": "module"`）；tsc 输出 `build/`，`rootDir: src`。
- 支持 Windows / macOS / Linux；`everything_search` 与 Everything 加速仅 Windows；macOS 系统信息走 sysctl，Linux 走 /proc+free。
- shell 相关环境变量（2026-08-16 powershell-default-shell 起，仅 Windows 生效）：`MCP_SHELL`（默认 `pwsh`，可选 `powershell` / `cmd`）、`MCP_POWERSHELL_PATH`（显式执行器路径，无效即硬失败）；解析结果进程级缓存，修改后需重启。

### 安全硬边界（任何 `MCP_SAFETY_MODE` 下生效）
- Windows 禁止路径：`C:\Windows`、`Program Files` 等 9 个系统目录；Unix：`/etc`、`/proc` 等 11 个。
- 路径含 `..` 段或 URL 编码穿越（含多重编码）一律拒绝。
- 敏感文件（`.env`、SSH 密钥、`kubeconfig` 等）与敏感目录（`.ssh`/`.aws`/`.kube` 等）拒绝读写。
- 危险命令黑名单硬拦（含解释器 system / 管道到 shell / PowerShell iex 等 E 侧间接执行规则与 D 侧 PowerShell 注入规则的并集）；关键进程（csrss/svchost/explorer 等）禁止 kill。
- URL 仅 `http/https`；主机名仅 `[a-zA-Z0-9.\-:]`。
- 安全确认覆盖命令执行、删除、覆写、复制/移动、归档写入/解压和下载写入。
- hardBlock 为尽力而为的黑名单；完整沙箱需 OS 级隔离（见 `compound/2026-07-12-decision-command-execution-not-sandbox.md`）。

### 资源上限
- `MCP_COMMAND_MAX_OUTPUT_BYTES` 默认 50MB；`execute_command` 文本结果截断 2000 字符，错误摘要截断 500 字符；分页单页默认 2000 字符、最大 10000 字符。
- M2 当前共享捕获还进程级校验 `MCP_COMMAND_MEMORY_OUTPUT_BYTES`（默认 1MiB）、`MCP_COMMAND_MAX_STDERR_BYTES`（默认 1MiB）和 `MCP_TEMP_MAX_TOTAL_BYTES`（默认 1GiB）；关系或数值非法时在 spawn 前返回 `VALIDATION_ERROR`。
- 缓存 128 条 / 30s（目录 5s、系统信息 60s）。
- 命令限流 10 req/s（burst 20）；`MCP_BATCH_RATE_MODE=batch|per_command`。
- 临时资源 TTL / 数量上限 / 清理间隔由 `MCP_TEMP_TTL_MS` / `MCP_MAX_TEMP_DIRS` / `MCP_TEMP_CLEANUP_INTERVAL_MS` 控制。
- 审计日志最大保留条目数由 `MCP_AUDIT_MAX_ENTRIES` 控制；命令历史保留 50 条，持久化时保留 20 条。
- 默认超时：execute 30s（自适应 P95×3，上限 4×）、batch 每步 30s、watch 5s、下载 120s 等，见 `adaptive.ts`。

### 测试与覆盖策略
- 单元测试位于 `tests/unit/`（源码侧不混放 `*.test.ts`）；`src/tools/**` 与 `src/index.ts` 从覆盖率排除——工具处理器由 `tests/e2e-latency.test.ts` 子进程 e2e 覆盖（vitest 无法收集子进程覆盖率）。
- 当前基线在 merge-e-hardening-base 验收时刷新；e2e 延迟阈值全部达标为准入。

## 7. 规划入口（非现状）

剩余未闭环工作与**明确不做**边界见规划层（勿把计划写回本节当现状）：

- `codestable/roadmap/merge-e-hardening-into-d/`（当前执行中）
- `codestable/roadmap/remaining-hardening/remaining-hardening-roadmap.md`
- `codestable/roadmap/remaining-hardening/remaining-hardening-items.yaml`
- 约束决策：`compound/2026-07-12-decision-command-execution-not-sandbox.md`
