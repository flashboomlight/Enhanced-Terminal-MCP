---
doc_type: architecture
slug: enhanced-terminal
scope: Enhanced Terminal MCP 的系统总架构、模块边界和运行时约束
summary: 记录当前 MCP 入口、工具层、安全层、命令输出运行时和状态管理结构
status: current
last_reviewed: "2026-08-28"
tags: [mcp, typescript, terminal, security, command-output]
depends_on: []
implements: [everything-search-optional]
---

# Enhanced Terminal MCP 架构总入口

> 状态：current
> 创建日期：2026-08-16（由 `cs-arch backfill` 按 v3.1.0 代码现状补全）
> 最后核对：2026-08-29（M2 A+ 输出协议、M3 Everything 可选发布、M4 最终本地收口、hardening-contract-and-profiles、kill-process-identity、dependency-and-bootstrap-release、process-supervisor-and-cancellation、bounded-command-execution、path-policy-no-follow、secret-redaction-and-state-protection 与 network-and-archive-safety 均已完成验收；`.etmcp` 懒创建口径随 state-dir-eager-creation issue 修复收口）

## 1. 项目简介

Enhanced Terminal MCP v4.0.0 是一个基于 TypeScript / Node.js 的 MCP server，通过 stdio 传输协议向 AI 客户端提供 **27 个工具**（默认；`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时 26 个；命令执行、文件 I/O、文件管理、搜索、系统、归档、运维遥测 7 类）、2 个逻辑资源端点（`health://status` / `audit://log`）、2 个 prompt（`usage-guide` / `safety-info`）。

- 包入口：`build/index.js`（`src/index.ts` 编译产物）
- 依赖：`@modelcontextprotocol/sdk` 1.29（精确 + overrides；postinstall 只 patch package-owned SDK）、`zod` 3；传递依赖按 SDK 声明范围冻结到已修复版本，项目依赖由 pnpm 11.21.0 + `pnpm-lock.yaml` 管理，多个 MCP 可复用机器配置的 content store，但各自保留 virtual store 和 `node_modules`
- 主要消费方：Claude Desktop / Cherry Studio 等 MCP 客户端

## 2. 核心概念 / 术语表

| 术语 | 含义 |
|------|------|
| Tool / registerTool | 每个能力一个 MCP 工具，Zod `inputSchema` + `outputSchema` + `annotations`；工具数量由 `getRegisteredToolCount()` 动态统计 |
| wrapHandler | 统一 handler 包装器：从 MCP `extra` 映射 runtime `RequestContext`，并自动 telemetry 采集 + LRU 缓存命中/写入 |
| ToolResult | 统一结果协议 `{ok, content, structured, meta}` 或 `{ok:false, error}` |
| StructuredError | 31 个错误码 + `retryable` / `suggestion` / `param` / `detail` 提示（含 M2 已落地的 `SECRET_DETECTED` 与生产硬化错误码） |
| ExecutionProfile | 启动时固定的 `local-trusted-shell` / `sandboxed-production` 执行边界；当前 sandbox backend 未接入时 fail-closed |
| RequestContext | 由 MCP handler `extra` 提供 request id、session scope、profile 和 cancellation signal 的可信上下文 |
| CapabilityPolicy | 按 profile 和宿主声明决定 shell、argv、主机信息、网络和文件写入能力；不替代 OS sandbox 或认证 |
| BudgetAccount | request/batch/child/session 共享的 input/output/disk/queue/process/response 资源账本，带 deadline 和 AbortSignal |
| ProcessIdentity | 平台取得的 PID、精确名称、启动时间、opaque token 和可选 process group；token 绑定一次具体进程实例 |
| ProcessIdentityProvider | 精确枚举、PID identity probe、proof-bound termination 和有界退出确认；不接受 wildcard/name matching 作为终止凭据 |
| SafeGuard | 三级安全策略引擎（strict / normal / off）+ `MCP_COMMAND_CONFIRMATION` 命令风险分级；normal 默认走 MCP Elicitation 逐次确认 |
| hardBlock | 不可关闭的灾难性命令硬底线（所有安全模式含 off 均生效） |
| 硬性底线 | `security.ts` 的路径/命令/URL 校验，任何安全模式下都生效 |
| CommandSpec | 跨平台命令规格 `{file, args, useShell?}`，供 `execFile` 参数化执行 |
| ShellSpec / ShellInvocation | `shell.ts` 的解析产物与 spawn 调用构造 `{file, flavor, source, version?}`；Windows 一次性解析、进程级缓存 |
| spawnStream | 既有 spawn 流式执行器，供 `safeExec` / `quickExec` 等消费者使用 |
| CommandOutputRuntime | `capture.ts` + `command-output.ts` 的共享原始字节捕获、actual 计数、backpressure/drain、内存 retention、流式 secret matcher、staging spill 与 finalize（M2 已落地） |
| SessionStore | cwd / 自定义 env / 命令历史，持久化到 `<projectRoot>/.etmcp/session.json`；恢复时校验 cwd 与 env 黑名单 |
| Audit Log | 结构化审计日志（JSON Lines），按 `MCP_AUDIT_MODE` 控制写入 |
| Temp Manager | 临时资源生命周期管理器（懒创建 root、reservation、staging heartbeat、TTL + LRU） |
| Page Cache | `paging.ts` 已升级为 v2：原始字节 + 版本化字符索引（`stdout.bin`/`stderr.bin`/`stdout.idx`/`meta.json`）+ staging 原子发布 + 范围读取（M2 已落地） |
| ProcessPool | 预热的 shell 子进程池；**当前为 E 的 inactive stub，`pool_stats` 恒 `active:false`**，实际执行走 `spawnStream` |
| LRU 结果缓存 | 128 条上限、30s 默认 TTL 的工具级结果缓存 |
| TelemetryStore | 工具调用延迟/错误率/缓存命中率指标聚合 |

## 3. 子系统 / 模块索引

### 3.1 入口与工具层

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 入口：解析并固定 `MCP_EXECUTION_PROFILE`（backend 不可用时 fail-closed）→ 创建 McpServer → initSafeGuard → 注册业务工具 + 运维工具 → 注册资源/prompts → 连接 stdio → shutdown 时先请求 `processSupervisor` drain，再 flush session/audit（顺序已随 process-supervisor-and-cancellation 验收） |
| `src/tools/command.ts` | `execute_command` / `batch_execute` / `watch_command`。Windows 消费 `shell.ts` 统一解析的 shell spec（默认 pwsh 7，详见 ADR-7/14），Unix 用 `/bin/sh -c`；命令 policy + 危险模式检查 + 限流 + SafeGuard + audit 后调用共享 `runCommandOutput`，并把 `RequestContext` cancellation/scope 传给 managed execution。公开输入输出已是 M2 A+ envelope（分页/secret/容量字段） |
| `src/tools/files.ts` | `read_file`（分页/编码；real 解析重验后以 real 打开）/ `write_file`（秘密扫描 + 覆写确认 + 原子 staging 写；no-follow）/ `list_directory`（符号链接循环保护；real 入口）/ `file_info`（real 解析；可被 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 禁用）/ `make_directory`（父链重验） |
| `src/tools/manage.ts` | `copy_move`（源读语义/目标 no-follow，real 执行）/ `delete_path`（Elicitation 确认保护；递归删除需 `recursive=true`；symlink 仅移除链接本身） |
| `src/tools/search.ts` | `search_files`（Windows 优先使用经 resolver 校验的 Everything；隐式 state binary 不可用时原生递归兜底；显式配置错误直接结构化失败）/ `everything_search`（仅 Windows；binary 不可用时返回带安装信息的结构化失败）/ `grep_content`（解析为 pwsh/powershell flavor 时走统一 spec 的 Select-String → Unix grep → 原生三级降级；参数单引号内联转义）；Everything/grep child 已通过 managed execFile 接入 supervisor 并传递 RequestContext cancellation |
| `src/tools/system.ts` | `get_system_info` / `process_list` / `kill_process`（严格 PID/name XOR、ProcessIdentityProvider、关键/self/parent 保护）/ `network_info` / `environment_vars`（敏感键打码）；系统查询 child 已通过 managed `safeExecFile` 接入 supervisor |
| `src/tools/archive.ts` | `compress_archive` / `extract_archive`（Windows 走 PowerShell Compress/Expand-Archive）/ `download_file`（HTTP/HTTPS 白名单 + 指数退避重试）；归档 child 已通过 managed `safeExecFile` 接入 supervisor |
| `src/tools/utility.ts` | `telemetry_report` / `cache_stats` / `session_state` / `pool_stats` / `temp_stats` 等运维工具 |

### 3.2 横切基础层

| 模块 | 职责 |
|------|------|
| `src/security.ts` | 路径穿越（含 URL 多重编码绕过）、系统目录黑名单、敏感文件/目录模式、危险命令正则（D 的 PowerShell `-EncodedCommand`/`iex`/`Start-Process`/`Stop-Computer`/`Set-ExecutionPolicy`/盘符根递归删除 + E 的间接执行/解释器/管道绕过规则的并集）、URL 协议白名单、主机名校验、进程名消毒 |
| `src/command-policy.ts` | 命令策略统一入口：`blocklist`（默认）/ `allow`（词级白名单 + 禁止 shell 元字符/管道/嵌套 shell）；hardBlock 永远先执行 |
| `src/path-policy.ts` | 统一路径解析策略：读语义 real 解析重验（realpath→forbidden/sensitive 重跑）、写/删/移 no-follow（symlink 目标拒绝）、原子 staging 写（exclusive wx + rename）、state/temp 根替换检查；判定函数复用 security.ts，不复制黑名单 |
| `src/command-budget.ts` | 三个命令工具的预算常量与 batch parent BudgetAccount 构建（聚合输入/output/wall-time）、skip 分类和 handler 层 `validateBoundedCommandInput` 二次校验；不执行命令、不判断安全 |
| `src/safeguard.ts` | strict 禁用受保护工具；normal 默认走 Elicitation；risk-gated 下命令工具经 `guardCommandByRisk` 分级（ordinary 放行 / heavy 带原因确认），关键进程黑名单全模式生效 |
| `src/command-risk.ts` | 命令风险纯分类层：`MCP_COMMAND_CONFIRMATION` 解析（非法回退 all）、`classifyCommandRisk`/`classifyBatchRisk`（batch>5 / 破坏类残余 / 性能词表 / watch duration>60s），规则表数据化、语料治理（tests/fixtures/command-risk-corpus.json） |
| `src/result.ts` | ToolResult 协议、31 错误码、`fail`/`success` 工厂、MCP `CallToolResult` 转换；命令类 A+ envelope 与 `SECRET_DETECTED` 已落地 |
| `src/hardening-contract.ts` | 生产硬化共享类型、strict finite/int/bounded schema helper、strict config integer 和 parent/child `BudgetAccount`；不直接执行命令或访问文件 |
| `src/profile.ts` | 启动 profile 解析/固定、sandbox availability fail-closed、MCP extra → `RequestContext` 和 local/sandbox `CapabilityPolicy` |
| `src/process-supervisor.ts` | 当前工作树中的 managed child registry：`ProcessSupervisor`/`processSupervisor`、snapshot/state、active limit、timeout/AbortSignal、幂等 termination、Unix group/Windows PID-tree adapter 和 shutdown report；feature 尚未完成 acceptance |
| `src/process-identity.ts` | `kill_process` 的严格目标解析、Windows/Linux/macOS identity probe、start-time token、PID-only/tree termination adapter 和退出确认；无法证明身份时 fail-closed |
| `src/wrap.ts` | handler 包装：MCP `extra` → `RequestContext`、telemetry 记录 + 缓存命中/回填 |
| `src/cache.ts` | LRU 实现 + `CACHEABLE_TOOLS`（7 个只读工具）+ 工具级 TTL + 按前缀/路径失效 |
| `src/telemetry.ts` | 指标环形历史（1000 条）+ 按工具聚合 + 全局 summary |
| `src/session.ts` | cwd/env/history 管理，去抖持久化到 `<projectRoot>/.etmcp/session.json`；恢复消毒 |
| `src/state-dir.ts` | 统一状态目录解析：固定 `projectRoot`（`realpath(process.cwd())`，进程级不变）、默认 `<projectRoot>/.etmcp`、`MCP_STATE_DIR` 覆盖只解析一次；`getStateDir` 为纯解析（不创建目录），`ensureStateDir` 仅供写路径在真实产生物落盘前调用；旧 `.enhanced-terminal-mcp` 迁移协议 |
| `src/audit.ts` | 结构化审计日志写入与读取（`<projectRoot>/.etmcp/logs/audit.jsonl`） |
| `src/temp-manager.ts` | TempManager 执行器（懒创建、reservation、跨进程短锁、staging heartbeat/恢复、TTL + LRU 回收）；基础设施层拆至 `src/temp-core.ts`（helpers/环境读取器/错误/接口/AsyncMutex/ReservationImpl），公开 API 经 re-export 保持不变 |
| `src/paging.ts` | page cache v2 编排与公开 API（原始字节 `stdout.bin`/`stderr.bin` + `stdout.idx` 字符索引 + `meta.json`；staging 原子发布，读取只加载目标页范围）；子模块 `src/paging/`：`codec.ts` 字节编解码、`index-format.ts` 索引格式、`paths.ts` 路径断言、`errors.ts` 错误类型 |
| `src/capture.ts` | child lifecycle、stdout/stderr 原始 Buffer chunk、actual 字节计数、backpressure、drain、supervisor timeout/AbortSignal、pending bytes 上限和消费失败处理（registry cleanup 随 process-supervisor-and-cancellation 验收闭合） |
| `src/command-output.ts` | 三个命令工具共享的输出编排：limits 校验、流式 matcher、quarantine/fallback、双流抑制、staging spill 与 finalize、envelope 组装（M2 已落地） |
| `src/secret-registry.ts` / `src/secret-stream.ts` | whole-string registry 与流式 matcher 的单一 pattern 来源；固定 8192-byte quarantine 和 65536-byte fallback preview |
| `src/es-integrity.ts` | Everything CLI 本地可选解析：`ENHANCED_TERMINAL_ES_PATH`（显式，fail-closed）→ `<state-dir>/tools/es.exe`（隐式）→ unavailable；lstat 普通文件 + fingerprint + 固定 SHA-256，成功缓存按 fingerprint 失效，并发共享 in-flight；不下载、不读取仓库 fixture（M3 S1–S5 已验收） |
| `src/shell.ts` | Windows shell 解析与调用构造的唯一归属：`resolveShell`（纯选择逻辑，候选可注入）→ `getShellSpec`（进程级缓存，成败皆缓存）→ `buildShellInvocation`（唯一 flavor→参数/编码转换入口，pwsh 7 与 5.1 统一加 UTF-8 preamble，cmd 保留 chcp）；`where` probe 已改为 managed 异步路径；另提供 `powerShellTarget`、旧 `getShell`/`wrapCommand` 兼容导出 |
| `src/stream.ts` | `spawnStream` 通过 `processSupervisor.spawnManaged` 执行，保留 stdout 10MB/stderr 1MB 上限并增加 supervisor timeout/AbortSignal/termination 状态；三个命令工具的 M2 捕获路径仍走 `capture.ts`（supervisor 接线已随 process-supervisor-and-cancellation 验收） |
| `src/pool.ts` | E 的 inactive stub（仅 stats / 生命周期钩子），`pool_stats` 固定 `active:false` |
| `src/platform.ts` | 平台判定 + `getShell`/`wrapCommand` 兼容再导出 + 各类 `get*Spec` 跨平台命令构造 |
| `src/adaptive.ts` | 自适应超时（历史 avg×3，上限 4× 默认）+ `withRetry` 指数退避 |
| `src/ratelimit.ts` | TokenBucket（10 req/s，burst 20）；`checkRateLimit` |
| `src/utils.ts` | `safeExec`（shell spec + managed `spawnStream`）/ `safeExecFile`（managed 参数化执行）/ strict `envInt` / `formatSize` |
| `src/scan.ts` | write_file 前扫描 OpenAI/GitHub/AWS/JWT/Slack/连接串等 10 类凭据 |
| `src/regex.ts` | 正则编译缓存 + 基础 ReDoS 拒绝 |
| `src/context.ts` | 为 `usage-guide` prompt 注入会话上下文；不参与命令执行链 |
| `src/logger.ts` | 分级结构化日志（写 stderr，`MCP_LOG_LEVEL` 控制） |
| `src/version.ts` | 版本信息读取 |

### 3.3 外部资产

| 路径 | 说明 |
|------|------|
| `es_tool/es.exe` | Everything CLI 仓库开发/测试 fixture（固定 SHA-256 锁定）；生产 resolver 不读取它，npm 发布物也不包含它 |
| `scripts/ensure-pwsh.ps1` | 便携 pwsh 7 bootstrap（纯 ASCII——PS 5.1 会把无 BOM UTF-8 按 GBK 误解析），仅 `setup.bat` 显式触发 |
| `tools/pwsh/` | bootstrap 安装的便携 pwsh 7（`.version` 版本标记；与 `tools/.pwsh-staging/` 一并被 gitignore） |
| `scripts/apply-mcp-sdk-patch.mjs` | postinstall 零依赖 SDK 补丁脚本；`patch-package` 仅 devDependency |
| `scripts/verify-package.mjs` | 源码侧发布验证器：实际 tarball 清单、manifest、入口、source map、禁发文件和 SHA-256；不随 npm package 发布 |
| `scripts/verify-clean-consumer.mjs` | 源码侧 clean npm consumer、package-owned SDK 隔离、SBOM 和 startup smoke 验证器；不随 npm package 发布 |
| `patches/` | patch 开发参考 |
| `build/` | `pnpm run build` 先清理后生成的 tsc 产物；不应保留已从 `src/` 删除的历史文件 |
| `scripts/clean-build.mjs` | build 前只清理项目根目录下的 `build/`，避免旧编译文件进入 npm 发布包 |

## 4. 状态目录结构

```
<projectRoot>/.etmcp/
├── session.json（session 首次持久化时按需创建）
├── logs/
│   └── audit.jsonl
└── temp/（仅首次真正需要临时资源时创建）
    └── page-cache-{timestamp}-{random}/（page cache v2 布局）
        ├── stdout.bin
        ├── stderr.bin
        ├── stdout.idx
        └── meta.json
```

- `projectRoot = realpath(process.cwd())`，server 启动时计算一次，进程生命周期内不变；`MCP_STATE_DIR` 相对路径只相对固定 `projectRoot` 解析一次。
- **懒创建**：`.etmcp` 目录（含 `logs/`、`temp/`）只在第一个真实产生物落盘时创建——session 持久化、audit 条目写入、temp/page-cache 资源创建、legacy 迁移产物。server 启动、session 恢复读取、`audit://log` / `health://status` 资源读取、`telemetry_report` / `temp_stats` 展示一律零创建（2026-08-26 state-dir-eager-creation issue 修复）。
- 旧 `<projectRoot>/.enhanced-terminal-mcp` 的 `session.json` 与 `logs/audit.jsonl` 按 roadmap 4.5 迁移协议自动迁移（排他锁、同卷 staging、原子替换、回读验证、失败报 `STATE_MIGRATION_FAILED`）；旧 `temp` 与未知文件永不迁移。
- 全局 `%TEMP%\.enhanced-terminal-mcp-session.json` 不自动导入或删除，发现时只记录不含内容/cwd/env 的提示。

## 5. 关键架构决定

- **ADR-1 stdio 单传输**：`StdioServerTransport`，每客户端一进程；所有日志走 stderr 避免污染协议流。
- **ADR-2 全部工具带类型化 schema**：Zod `inputSchema` + `outputSchema` + `annotations`（readOnly/destructive/idempotent hints），输出同时给人类文本和 `structuredContent`。
- **ADR-3 统一结果协议**：所有 handler 返回 `ToolResult`，错误统一 20 个错误码并携带 LLM 可决策的 `retryable/suggestion/param`；命令类 `SECRET_DETECTED` 与完整 A+ envelope 已随 M2 落地。
- **ADR-4 中间件化横切**：`wrapHandler` 统一做 telemetry 和缓存，handler 本体不感知。
- **ADR-5 安全双层**：`security.ts` 硬性底线（任何模式生效）+ `safeguard.ts` 策略层（strict/normal/off + 命令分级确认）；normal 默认 Elicitation 逐次确认；决策顺序 strict →（risk-gated：ordinary 放行 / heavy 带原因确认）→ off → normal；危险命令正则、关键进程保护属于硬底线。hardBlock 全模式（含 off）不可关闭；非 allow 安全决策统一以 `action=safety.decision` 写入审计（heavy 决策含 `risk_level`/`risk_category`）。原 headless surface（`MCP_CONFIRMATION_MODE`/`MCP_ALLOWED_ROOTS`/`delete_preview`）已于 v4.0.0 整体拆除（DEC-002：对齐官方 MCP——Roots 已废弃、目录限制归宿主沙箱）。
- **ADR-6 跨平台 CommandSpec**：能参数化的系统命令一律 `execFile(file, args)`；需要 shell 特性的才走 shell，并限制在上游已校验的输入。
- **ADR-7 Windows 默认 PowerShell（2026-08-16 powershell-default-shell 起取代旧 cmd 方案）**：命令工具与平台 spec 统一消费 `shell.ts` 解析的 shell spec。默认 `MCP_SHELL=pwsh`，按「`MCP_POWERSHELL_PATH` 显式路径（fail closed）→ 项目便携 pwsh 7（`tools/pwsh`）→ PATH pwsh → Windows PowerShell 5.1 回退」一次解析、进程级缓存（成败皆缓存，改配置/装 pwsh 需重启）；`MCP_SHELL=cmd|powershell` 为兼容档（cmd 档下 PS 类平台 spec 回退 powershell.exe 保持 v3.1 行为）；Unix 不进入该流程仍 `/bin/sh`。中文 Windows 实测 pwsh 7 管道输出同为 GBK，故 invocation 层对 pwsh 7 与 5.1 统一加 UTF-8 preamble。
- **ADR-8 流式执行**：既有 `safeExec` / `quickExec` 继续使用 `spawnStream`（输出超上限截断并终止；超时先 SIGTERM，2s 后 SIGKILL）；`execute_command` / `batch_execute` / `watch_command` 已切换到 `capture.ts` 共享捕获与 `command-output.ts` 编排；输出超限停止 retention 并继续 drain，公开成功/错误 envelope 已随 M2 收口。
- **ADR-9 只缓存幂等只读工具**：`CACHEABLE_TOOLS` 白名单 7 个工具；默认 TTL 30s，目录 5s、系统信息 60s；写操作按路径失效相关缓存；含密钥扫描命中的内容不写入 LRU。
- **ADR-10 会话持久化**：cwd/env/history 存 `<projectRoot>/.etmcp/session.json`，去抖写盘，重启恢复并消毒（拒绝危险 env 键与非法 cwd）。
- **ADR-11 Windows 搜索可选 Everything**：执行前经 `es-integrity` 解析（`ENHANCED_TERMINAL_ES_PATH` → state 目录 → unavailable）并做固定 SHA-256 校验；`search_files` 只对隐式 unavailable 原生兜底，显式配置错误 fail-closed；`everything_search` 返回包含原因、固定 hash、默认路径和 `download_performed=false` 的结构化安装提示；npm 发布物不包含 `es.exe`。
- **ADR-12 SDK 补丁**：SDK 输出 schema 缺 `required` 数组会让严格校验器（OpenAI/DeepSeek 等）失败；postinstall 零依赖脚本只对 package-owned SDK 1.29.0 保证显式 `required: []`，版本/布局/模式漂移 fail-closed。
- **ADR-13 进程池未接入执行链**：merge 采用 E 的 inactive stub，`pool_stats` 固定 `active:false`；命令工具实际走 `spawnStream` 按需 spawn。
- **ADR-14 bootstrap 可联网、运行期绝不联网**：便携 pwsh 7 由 `setup.bat → scripts/ensure-pwsh.ps1` 显式安装——固定版本（7.6.5）+ 官方 SHA256 + 仓库内 `tools/.pwsh-staging` 原子替换；`tools/pwsh`、staging 均不入 Git。MCP server 运行路径零网络依赖，未找到候选 shell 时返回结构化错误（`INVALID_SHELL_MODE` / `SHELL_PATH_INVALID` / `SHELL_NOT_FOUND`）。
- **ADR-15 状态根固定 projectRoot**：默认状态目录 `<projectRoot>/.etmcp`，不随 `session_state set_cwd` 或单条命令 cwd 漂移；npm 包安装目录、源码目录、`build/` 目录不得作为默认状态根。
- **ADR-16 命令 policy**：`MCP_COMMAND_POLICY=blocklist`（默认）/ `allow`；allow 用词级可执行白名单并禁止 shell 元字符/管道/嵌套 shell，仍叠加 hardBlock；`batch_execute` 执行前全量预检，任一失败整批不部分执行。
- **ADR-17 M2 A+ 输出协议（2026-08-21 验收通过）**：三个命令工具共享 `runCommandOutput` 的原始字节捕获、内存 scanner、staging spill、page cache v2、`SECRET_DETECTED` 与 batch/watch/cache read A+ envelope；阶段 C 门禁在该次 M2 验收时通过。当前分页触发规则见 `codestable/compound/2026-08-22-decision-command-output-spill-paging.md`。M3 Everything 可选解析与发布裁剪已验收；M4 仍负责整体文档和发布口径最终复核。
- **ADR-18 确认模型收敛（v4.0.0，DEC-002）**：拆除 headless surface（`MCP_CONFIRMATION_MODE`/`MCP_ALLOWED_ROOTS`/`delete_preview`/`workspace-delete.ts`/`headless-policy.ts`），新增 `MCP_COMMAND_CONFIRMATION=all|risk-gated` 命令分级确认（ordinary 免确认 / heavy 经 Elicitation 带风险原因一次确认；off 只豁免 ordinary）；对齐官方 MCP 设计哲学——Roots 已废弃（SEP-2577）、文件系统限制归宿主沙箱、危险操作逐次确认 + step-up 提权；推荐配置 `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`。heavy 规则表改动必须过入库语料。
- **ADR-19 生产硬化共享契约（2026-08-28）**：`hardening-contract-and-profiles` 已落地 `RequestContext`、启动固定的 `MCP_EXECUTION_PROFILE=local-trusted-shell|sandboxed-production`、capability policy、strict finite/int/bounded schema、strict config integer、parent/child `BudgetAccount` 和生产硬化错误码。未设置 profile 保持 local 兼容；unknown profile 为 `CONFIG_INVALID`；当前 sandbox backend 尚未接入，选择 `sandboxed-production` 返回 `SANDBOX_UNAVAILABLE`，不得静默降级。`wrapHandler` 将 MCP handler `extra` 的 `requestId/sessionId/signal` 映射到可信 context；后续 process/path/secret/network/archive feature 必须消费这些契约，但本 ADR 不宣称它们已经完成资源或 OS 隔离。
- **ADR-20 进程身份绑定终止（2026-08-28）**：`kill-process-identity` 已将 `kill_process` 收敛为严格互斥的 PID 或精确名称；名称先枚举且必须唯一，PID/name 都必须取得并在终止前重验 platform identity token/start time。Windows 不使用 name `/IM`，Unix 不使用 `pkill`；`force=true` 才请求已验证 process tree/process-group termination，目标未消失或 proof 不可用时返回结构化失败。该能力仍是单工具 provider，不等于后续全局 process supervisor、active registry、统一 cancellation 或 OS sandbox。
- **ADR-21 发布与 bootstrap 收敛（2026-08-28）**：dependency-and-bootstrap-release 保持 SDK 1.29.0 wire/API 基线，仅刷新其声明范围内的传递依赖；pnpm audit --prod --audit-level=high 作为 high/critical 阻断。源码入口由 setup.bat 负责 pnpm/build/可选 pwsh bootstrap，npm consumer 只使用发布包的 bin/build/index.js，运行期不下载。prepack 强制 clean build，tsconfig inlineSources 使 source map 自包含，package files 不含 source/tests/lockfile/state/fixture/bundled pwsh；postinstall 只 patch package-owned SDK，使用同目录原子替换，版本/布局/模式漂移 fail-closed。setup bootstrap 具备 Node/pnpm 版本检查、--non-interactive、120 秒下载超时、250 MB 下载上限和 staged reparse 检查；tsx 作为 devDependency 固定。源码侧 verifier 产生 tarball SHA-256，clean consumer 另行验证不同版本 SDK 不被误改、CycloneDX SBOM 和 startup smoke。provenance/签名仍由后续 CI/release gate 产生，不能由本地 checksum 代替。
- **ADR-22 统一进程监管与取消（2026-08-28）**：`process-supervisor-and-cancellation` 已验收。全部生产 child（三个命令工具捕获路径、`spawnStream`、`safeExecFile`、Everything/grep/system/archive、kill identity、shell where probe、supervisor 自身控制进程）经 `processSupervisor` registry 纳管；active 上限在 spawn 前生效，timeout/AbortSignal/termination 幂等；Windows 使用 PID-only `taskkill /PID <pid> /T /F`，Unix 使用 detached 进程组负 PID 信号，均不接受用户输入作为 tree scope；capture pending bytes 有界；RequestContext cancellation 贯穿 command/search/system/archive；shutdown 先 supervisor drain（非 clean 记录 degraded evidence）再 flush session/audit。验收期间修复 registry cleanup 竞态（child 已退出即双向立即回收）。descendant/parent budget 归属 `bounded-command-execution`；本 ADR 不宣称 OS 级进程隔离。

## 6. 已知约束 / 硬边界

### 运行环境
- Node.js ≥ 20；ESM（`"type": "module"`）；tsc 输出 `build/`，`rootDir: src`。
- 支持 Windows / macOS / Linux；`everything_search` 与 Everything 加速仅 Windows；macOS 系统信息走 sysctl，Linux 走 /proc+free。
- shell 相关环境变量（2026-08-16 powershell-default-shell 起，仅 Windows 生效）：`MCP_SHELL`（默认 `pwsh`，可选 `powershell` / `cmd`）、`MCP_POWERSHELL_PATH`（显式执行器路径，无效即硬失败）；解析结果进程级缓存，修改后需重启。
- 生产硬化 profile：`MCP_EXECUTION_PROFILE` 未设置时为 `local-trusted-shell`；只接受 `local-trusted-shell|sandboxed-production`，解析结果进程级固定；当前 `sandboxed-production` backend 未实现，显式选择时启动 fail-closed。

### 安全硬边界（任何 `MCP_SAFETY_MODE` 下生效）
- Windows 禁止路径：`C:\Windows`、`Program Files` 等 9 个系统目录；Unix：`/etc`、`/proc` 等 11 个。
- 路径含 `..` 段或 URL 编码穿越（含多重编码）一律拒绝。
- 敏感文件（`.env`、SSH 密钥、`kubeconfig` 等）与敏感目录（`.ssh`/`.aws`/`.kube` 等）拒绝读写。
- 危险命令黑名单硬拦（含解释器 system / 管道到 shell / PowerShell iex 等 E 侧间接执行规则与 D 侧 PowerShell 注入规则的并集）；关键进程（csrss/svchost/explorer 等）禁止 kill。
- `kill_process` 的输入必须是 PID/name 二选一；名称必须精确且唯一，PID 必须绑定 identity proof；当前 server、parent 和关键系统进程拒绝，不能以 `/IM`、`pkill` 或裸 PID name matching 终止。
- URL 仅 `http/https`；主机名仅 `[a-zA-Z0-9.\-:]`。
- 安全确认覆盖命令执行、删除、覆写、复制/移动、归档写入/解压和下载写入。
- hardBlock 为尽力而为的黑名单；完整沙箱需 OS 级隔离（见 `compound/2026-07-12-decision-command-execution-not-sandbox.md`）。
- `CapabilityPolicy`、`BudgetAccount` 和 `RequestContext` 是应用层契约，不等于 OS sandbox；后续 feature 未完成前，不能以它们宣称 process tree、文件系统或网络隔离已具备。

### 资源上限
- `MCP_COMMAND_MAX_OUTPUT_BYTES` 默认 50MB；`execute_command` 文本结果截断 2000 字符，错误摘要截断 500 字符；分页单页默认 2000 字符、最大 10000 字符。
- 共享捕获进程级校验 `MCP_COMMAND_MEMORY_OUTPUT_BYTES`（默认 1MiB）、`MCP_COMMAND_MAX_STDERR_BYTES`（默认 1MiB）和 `MCP_TEMP_MAX_TOTAL_BYTES`（默认 1GiB）；关系或数值非法时在 spawn 前返回 `VALIDATION_ERROR`。
- `hardening-contract.ts` 提供 strict finite/int/bounded 与 parent/child budget 基础；`envInt` 已接入 strict integer；三个命令工具的输入 schema（`finiteInt`/`boundedString`/`boundedArray`）与 batch parent BudgetAccount 已随 bounded-command-execution 接入（`src/command-budget.ts`），其余工具 schema 和实际执行 budget 仍由 production-hardening roadmap 后续 feature 接入。
- `process-identity.ts` 提供 `kill_process` 的 identity provider 和 PID-only termination；`process-supervisor.ts` 提供全量 registry、统一 cancellation 和 shutdown drain（已随 process-supervisor-and-cancellation 验收），timeout/cancel/shutdown 后 registry 无残留由回归测试保证。
- 缓存 128 条 / 30s（目录 5s、系统信息 60s）。
- 命令限流 10 req/s（burst 20）；`MCP_BATCH_RATE_MODE=batch|per_command`。
- 临时资源 TTL / 数量上限 / 清理间隔由 `MCP_TEMP_TTL_MS` / `MCP_MAX_TEMP_DIRS` / `MCP_TEMP_CLEANUP_INTERVAL_MS` 控制。
- 审计日志最大保留条目数由 `MCP_AUDIT_MAX_ENTRIES` 控制；命令历史保留 50 条，持久化时保留 20 条。
- 默认超时：execute 30s（自适应 P95×3，上限 4×；`adaptive.ts` 的 DEFAULT_TIMEOUTS 仅登记 execute_command，其余工具超时由各自 handler 显式给定：batch 每步 30s、watch 5s、下载 120s）。

### 测试与覆盖策略
- 单元测试位于 `tests/unit/`（源码侧不混放 `*.test.ts`）；主 coverage 配置排除 `src/index.ts`、`src/tools/**`、`src/**/*.test.ts` 和 `tests/**`，因为 Vitest/V8 无法收集子进程覆盖率；工具行为主要由 `tests/e2e-latency.test.ts` 子进程 e2e 覆盖，工具纯逻辑由 `tests/unit/tools/` 覆盖（files/manage/system/archive 有专属单测）。coverage 运行跳过延迟基准文件，避免插桩开销造成假失败。
- 工具层有专属覆盖率门禁 `pnpm run test:coverage:tools`（`vitest.tools-coverage.config.ts`，底线 statements/lines 55、functions 60、branches 45），使被主配置排除的工具层保持可度量、防回归；完整本地门禁一键跑 `pnpm run gate`。
- CI（`.github/workflows/ci.yml`）：ubuntu 跑 lint + 类型检查；windows runner（Node 22/24 矩阵）跑 build、tsc、全量测试、工具层覆盖门禁；latency 基准在 CI 上 `continue-on-error`（阈值按开发机校准，共享 runner 噪声大）。
- 当前基线在 merge-e-hardening-base 验收时刷新；e2e 延迟阈值全部达标为准入。
- 发布验证：源码侧执行 `pnpm run build`、`pnpm run audit:prod` 或等价 audit 命令、`node scripts/verify-package.mjs`、`node scripts/verify-clean-consumer.mjs <tarball>`；package verifier 当前验证 189 个文件，clean consumer 验证 package-owned SDK 1.29.0、consumer SDK 1.30.0、96 个生产 SBOM 组件和 startup smoke。该命令链尚未替代后续 canonical CI/security gate。

## 变更日志

- 2026-08-28：同步 `process-supervisor-and-cancellation` 的当前 working-tree partial implementation（managed registry、主要执行入口接线、RequestContext cancellation 和 shutdown 顺序），并明确其定向测试失败与未验收边界；未将其记录为稳定完成能力。
- 2026-08-28：`process-supervisor-and-cancellation` 完成验收——修复 registry cleanup 竞态（close 事件与 termination promise 完成顺序不确定导致 `activeCount` 残留，改为 child 已退出即双向立即回收）与 lint 三处；登记 ADR-22；门禁全绿（全量 51 文件 639 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 4/13。
- 2026-08-28：`bounded-command-execution` 完成验收（最小闭环达成）——新增 `src/command-budget.ts`，三个命令工具接入 `finiteInt`/`boundedString`/`boundedArray` schema 与 handler 层 `validateBoundedCommandInput` 二次校验；batch 建立 parent BudgetAccount（聚合输入预检 `RESOURCE_LIMIT` 零执行、output 逐条配额 `budget_output`、wall-time deadline `budget_deadline`、parallel 经 child() 共享 parent ledger）；`skip_reason` 扩展为四值枚举；门禁全绿（全量 52 文件 658 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 5/13。
- 2026-08-29：`path-policy-no-follow` 完成验收——新增 `src/path-policy.ts` 统一路径策略并接入 files/manage/session/state/temp：读语义 real 解析重验、写/删/移 no-follow（symlink→敏感目录读取收紧为 `PATH_FORBIDDEN`）、覆写原子 staging+rename、state/temp 根防替换（关闭审计 SEC-03）；门禁全绿（全量 53 文件 678 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 6/13。
- 2026-08-29：`secret-redaction-and-state-protection` 完成验收——新增 `src/secret-governance.ts`（统一 redactor + env policy + `redactError`），`fail()` 单点 ResultBoundary 覆盖全部 error 出口，logger/audit/prompt/confirmation/fatal 出口净化（控制字符转义 + 限长 + `[REDACTED]`）；session 默认只持久化 envKeys 与 redacted history（value 持久化需 `MCP_SESSION_PERSIST_ENV_VALUES=1`，denied/sensitive 永不落盘），env deny 大小写规范化关闭 `path`/`node_options` 变体；`scanContent` 增加 `complete` 语义、strict 超能力 fail-closed（`RESOURCE_LIMIT`）、不完整内容不入缓存；`environment_vars` 走 `MCP_ENV_VALUE_MODE`（默认 allowlist）并移出 `CACHEABLE_TOOLS`；session.json 走 `atomicWriteFile`，audit/state/temp POSIX 权限收紧（关闭审计 SEC-04/SEC-05 本范围缺口）；门禁全绿（全量 54 文件 709 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 7/13。
- 2026-08-29：`network-and-archive-safety` 完成验收——新增 `src/network-policy.ts`（IP 分类矩阵、SSRF deny-private/allow-private 策略、直连已验证 IP + servername=SNI 关闭 DNS rebinding、redirect 逐跳重验、字节预算与绝对 deadline 跨重试共享、代理变量零读取）与 `src/zip-policy.ts`（EOCD/ZIP64/CD manifest、Zip Slip/驱动器号/保留设备名/链接设备加密条目拒绝、manifest 预检 + 实时计数双路展开预算、压缩比守卫、staging 两阶段解压零残留）；download/extract 从 `Invoke-WebRequest`/`curl`/`Expand-Archive` 换为纯 Node 实现（零新增依赖），compress spawn 前源树预算预演，`network_info` ping/dns 接入 egress 校验，9 个配置项进 README（关闭审计 REL-04/SEC-07 本范围缺口）；门禁全绿（全量 56 文件 736 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 8/13。

- 2026-08-29：`tool-wrapper-and-surface-contract` 完成验收——新增 `src/tool-registry.ts` 以 SDK `RegisteredTool.enabled` 为唯一真源的真实启用计数，banner/health（`tools.enabled/disabled`）/usage-guide 与 `tools/list` 27/26 三面同源一致；`wrapHandler` 收敛未预期异常（取消→`CANCELLED`、其余→`INTERNAL_ERROR` 且经脱敏）并新增 `MCP_RESPONSE_MAX_BYTES`（默认 2 MiB）响应兜底；session_state/environment_vars/network_info 缺参显式 `VALIDATION_ERROR`（删除隐式 ping 127.0.0.1/localhost 默认）；`capabilityGate` 接线五个披露面（关闭审计 REL-05/PRO-01/PRO-02 与 SEC-06 capability 部分）；门禁全绿（全量 58 文件 752 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 9/13。
- 2026-08-29：`audit-health-and-state-writer` 完成验收——新增 `src/lock-lease.ts` 统一 temp/migration 锁的 owner/lease heartbeat/fencing 语义（心跳存活的长持锁不被接管、staging+rename 原子接管保留 fence 单调、崩溃 owner 立即恢复、未知迁移锁 fail-closed）；audit 改单飞行写链（失败保留退避重试、entry/queue 字节上限、按大小轮换 `audit.jsonl.N`、`record()/flush()/health()` 落 §5.7 契约）；session revision writer 以 revision 比对修复写窗口 dirty 竞态；temp 跨进程配额经 `.quota.json` ledger 互见 outstanding；LRU 超限 entry 拒绝 + 计数；`health://status` 从恒 `ok` 改为 `healthy|degraded|failed` + components 四组件聚合（关闭审计 OPS-01/OPS-02 与 lock fencing 验收行）；门禁全绿（全量 63 文件 786 用例、latency 24/24、tools coverage 达标）；生产硬化 roadmap 进度 10/13。

## 7. 规划入口（非现状）

剩余未闭环工作与**明确不做**边界见规划层（勿把计划写回本节当现状）：

- `codestable/roadmap/2026-08-19-merge-e-hardening-into-d/`（已完成，保留为历史规划与验收记录）
- `codestable/roadmap/2026-07-12-remaining-hardening/remaining-hardening-roadmap.md`
- `codestable/roadmap/2026-07-12-remaining-hardening/remaining-hardening-items.yaml`
- 约束决策：`compound/2026-07-12-decision-command-execution-not-sandbox.md`
