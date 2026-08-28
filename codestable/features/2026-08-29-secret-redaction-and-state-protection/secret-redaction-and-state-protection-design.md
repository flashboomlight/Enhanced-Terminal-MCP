---
doc_type: feature-design
feature: 2026-08-29-secret-redaction-and-state-protection
requirement:
roadmap: production-hardening
roadmap_item: secret-redaction-and-state-protection
status: approved
summary: 新增统一 SecretGovernance（redactor + env 大小写策略 + scan 完备性语义），接入 fail/logger/audit/session/prompt/confirmation 出口，默认不持久化 env value 与原始命令，strict 扫描不完整 fail-closed，environment_vars 走值展示策略且不再入缓存
tags: [production, hardening, secret, redaction, env-policy, session, audit, cache, fail-closed]
created: "2026-08-29"
last_reviewed: "2026-08-29"
depends_on: [2026-08-28-hardening-contract-and-profiles, 2026-08-29-path-policy-no-follow]
---

# secret-redaction-and-state-protection 设计

> 阶段：阶段 1（设计定稿）
> 创建日期：2026-08-29
> 状态依据：roadmap 第 6 条；用户已授权代理代为执行 CodeStable 全流程，design 由代理按 roadmap 既定范围审定并批准。
> 关联归档：SEC-04（session env/命令历史持久化、env 大小写绕过）、SEC-05（redaction 缺失：error/logger/prompt/confirmation）；证据矩阵 SEC-04/SEC-05 行归本 feature + tool-wrapper-and-surface-contract。

## 0. 术语约定

- **redactor**：对文本做"已注册 secret pattern + URL userinfo 凭据"替换的函数，命中替换为 `[REDACTED]`；只处理已注册模式，不承诺通用 DLP。
- **scan 完备性（complete）**：`scanContent` 实际扫描的字节是否覆盖全部输入。超过 `SCAN_CONTENT_MAX_BYTES`（4 MiB）的内容扫描其前缀并返回 `complete: false`；`complete: false` 不得被任何消费方视为"已证明安全"。
- **strict fail-closed**：`MCP_SECRETS_SCAN=strict` 下，扫描不完整（`complete: false`）的读/写/缓存路径必须拒绝或跳过，不得放行。
- **env key 规范化大小写**：Windows 环境变量不区分大小写，`path`/`node_options` 等小写变体与 `PATH`/`NODE_OPTIONS` 等价；deny/sensitive/allowlist 判定一律对 `key.toUpperCase()` 进行。
- **值展示策略（env value display）**：`environment_vars` 返回值时按 `MCP_ENV_VALUE_MODE` 决定显示原始值（经 redactor）、掩码 `***` 还是一律隐藏。

## 1. 决策与约束

### 需求摘要（roadmap 第 6 条 + §5.5 SecretGovernance 契约 + audit SEC-04/SEC-05）

- 建立统一 redactor 与 env policy 模块（roadmap 模块 E `secret-governance`），实现 §5.5 中 `redactText` / `redactCommand` / `redactError` / `sanitizeLogField` / `validateEnvKey` / `persistentEnvValueAllowed` 的可消费形态；`scanChunk`/`finish` 流式能力由既有 `SecretStreamMatcher.push/finish` 承担，不重复封装。
- 出口接入：error message/detail（`fail()` 单点）、logger 字段（控制字符转义 + 限长 + redact）、audit detail（record 时 redact）、session 持久化（env 默认只存 key、history 存 redacted 命令）、prompt context（usage-guide `last_cmd`）、risk-gated confirmation 文本、fatal stderr。
- `scanContent` 增加 `complete`/`scannedBytes`；strict 下 write/read/cache 三条消费路径 fail-closed 或跳过；缓存准入增加 complete 检查。
- `environment_vars` 移出 `CACHEABLE_TOOLS`，值展示走显式策略（默认 allowlist）。
- 状态文件安全模式：session.json 走 `atomicWriteFile`（0o600 + exclusive staging），audit.jsonl/compact 与 state/logs/temp 目录在 POSIX 上收紧权限；Windows 记录为不适用。

### 明确不做

- 不做 audit writer 轮换/重试/durable spool/session revision writer（→ `audit-health-and-state-writer`）。
- 不做 capability/profile 对 `process_list`/`get_system_info`/`network_info` 的准入矩阵（→ `tool-wrapper-and-surface-contract`）。
- 不修改 `SECRET_PATTERN_DEFS` 既有条目与 `secret-stream.ts` 状态机；redactor-only 的 URL userinfo 规则不进入流式 registry。
- 不修改 `DANGEROUS_PATTERNS`/`HARD_BLOCK_PATTERNS`/`hardBlock`/safeguard 模式逻辑；redaction 是出口净化，不是命令拦截。
- 不改 `FORBIDDEN_ENV_KEYS` 的 key 集合（只把判定改为大小写规范化）；不新增 deny key。
- 不承诺对未注册格式（任意 base64 blob、自定义 header）的识别。
- 不追溯清洗既有 `audit.jsonl`/`session.json` 中的历史原文（redaction 只对本次运行新写入的数据生效；历史文件的清理/轮换归 `audit-health-and-state-writer`）。

### 现状证据与根因

- `session.ts:17-28` `FORBIDDEN_ENV_KEYS` 大小写敏感（`Set.has` 精确匹配），`path`/`node_options` 变体可绕过持久化注入（SEC-04）。
- `session.ts:162-181` `saveToDisk` 持久化完整 env **value** 与原始命令 history（最近 20 条），文件用 `${stateFile}.tmp` + rename（非 exclusive staging、默认权限）。
- `audit.ts:68-72` `record` 不做 redaction；`command.ts:155` `detail: { command, ...detail }` 把命令原文写入 audit。
- `result.ts:141-173` `fail()` 不做 redaction；`Errors.commandBlocked/commandDangerous/timeout` 把命令原文放进 `detail`；`content` 直接拼接 message。
- `logger.ts:21-25` `formatMsg` 直接内插 detail，无控制字符转义、无限长、无 redact（log forging 面）；`safeguard.ts:295` strict-block 日志携带命令原文。
- `context.ts:22-25` usage-guide prompt 注入 `last_cmd` 原文；`safeguard.ts:262-278` confirmation 文本含命令原文（含 batch 逐条）。
- `index.ts:129-132` fatal stderr 直接输出原始异常。
- `scan.ts:51-57` 超过 4 MiB 无条件 `{safe: true}`——违反 §5.5"scanner 不完整时不能返回 safe"。
- `cache.ts:183-191` `CACHEABLE_TOOLS` 含 `environment_vars`（任意 env 值可进共享缓存）；`system.ts:276-299` `get`/`list` 默认返回非敏感 key 的完整值，无显式 allowlist。

## 2. 设计方案

```mermaid
flowchart LR
    subgraph 出口边界（全部经 secret-governance）
        fail[fail / Errors.detail] --> G
        logger[logger.formatMsg] --> G
        audit[audit.record] --> G
        session[session.saveToDisk] --> G
        ctx[contextSuffix / confirmation] --> G
        fatal[index fatal stderr] --> G
    end
    G[secret-governance<br/>redactor + env policy]
    SCAN[scan.ts complete 语义] --> WRAP[wrap cache 准入]
    SCAN --> FILES[files strict fail-closed]
    G --> ENV[environment_vars 值展示策略<br/>+ 移出 CACHEABLE_TOOLS]
```

### 2.1 新模块 `src/secret-governance.ts`

模块 E 统一入口；判定来源复用 `secret-registry.ts`（不复制 pattern），env 判定函数收编自 session/utility/system。

- redactor：
  - `redactText(text)`：对模块初始化时生成的 g-flag 克隆 regex（不共享 `SECRET_PATTERNS` 原对象，避免 lastIndex 污染流式 matcher）逐条替换为 `[REDACTED]`；另加 URL userinfo 规则 `scheme://user:pass@ → scheme://user:[REDACTED]@`。
  - `redactCommand(cmd, maxChars = 2000)`：`redactText` + 字符数截断（截断尾部加 `…`）。
  - `redactDetail(detail: unknown, { maxBytes = 8192, maxStringChars = 1024 })`：JSON 可序列化则递归 redact 每个字符串值并逐串截断，序列化超限整体替换为 `{ truncated: true }`；不可序列化回退 `String()` 后 redact。
  - `sanitizeLogField(value, maxBytes = 2000)`：`String(value)` → `redactText` → 控制字符转义（`\r`→`\\r`、`\n`→`\\n`、`\t`→`\\t`、其余 C0/DEL→`\xNN`）→ UTF-8 字节截断。
  - `redactError(error: unknown): StructuredError`：归一为 `INTERNAL_ERROR`，message/suggestion 经 `sanitizeLogField`、detail 经 `redactDetail`（供 fatal 与后续 `tool-wrapper-and-surface-contract` 的 wrapper 兜底复用）。
- env policy（key 判定一律 `toUpperCase()` 后进行）：
  - `isDeniedEnvKey(key)`：现有 `FORBIDDEN_ENV_KEYS` 集合的大小写规范化判定（集合内容不增不减）。
  - `validateEnvKeyPolicy(key): string | null`：形状（非空、无 `=`、≤256）+ `isDeniedEnvKey`；`utility.validateEnvKey` 与 `session.setEnv`/`sanitizeRestoredEnv` 改为委托此函数。
  - `SENSITIVE_ENV_KEYWORDS`（自 `system.ts` 迁入）与 `envValueDisplayAllowed(key): boolean`：sensitive 一律 false；否则按 `MCP_ENV_VALUE_MODE`——`keys` → false，`allowlist`（默认）→ 内建非敏感白名单（`PATH`、`PATHEXT`、`HOME`、`USERPROFILE`、`TEMP`、`TMP`、`LANG`、`LC_ALL`、`TZ`、`OS`、`USERNAME`、`USER`、`SHELL`、`TERM`、`PWD`、`COMPUTERNAME`、`PROCESSOR_ARCHITECTURE`、`NUMBER_OF_PROCESSORS`、`EDITOR`、`VISUAL`）∪ `MCP_ENV_VALUE_ALLOWLIST`（逗号分隔补充项），`full` → true。
  - `persistentEnvValueAllowed(key)`：`MCP_SESSION_PERSIST_ENV_VALUES=1` 且 !denied 且 !sensitive。
- 新环境变量（写入 README）：`MCP_ENV_VALUE_MODE=allowlist|full|keys`（默认 `allowlist`）、`MCP_ENV_VALUE_ALLOWLIST`、`MCP_SESSION_PERSIST_ENV_VALUES=1|0`（默认 0）。
- 依赖纪律：`secret-governance.ts` 运行时只 import `secret-registry.ts`（对 `result.ts` 仅 `import type`），**不导入 logger**——`MCP_ENV_VALUE_MODE` 非法值的告警由消费方（system.ts）在调用 `getEnvValueMode()` 时输出。这保证 `result.ts → secret-governance → logger` 不构成模块加载期循环。

### 2.2 scan 完备性与消费方

- `scan.ts`：`ScanResult` 增加 `complete: boolean; scannedBytes: number`；超限内容扫描前缀（按 UTF-8 边界截断）返回 `complete: false`；tier=off 返回 `{safe:true, findings:[], complete:false, scannedBytes:0}`（off 语义即"调用方不得依赖扫描结果"）。
- `wrap.ts` 缓存准入：`safe && complete` 才入缓存（不完整内容一律不进共享缓存）。
- `files.ts` write：findings 命中维持现有 `SECRET_DETECTED` 拦截；strict 且 `!complete` → `RESOURCE_LIMIT` 拒绝；非 strict 不完整 → 放行——这是 tier 语义下的**允许决策**，不代表扫描结果"声称 safe"（写路径是用户自有内容，扫描为防泄露而非准入）。
- `files.ts` strict 读：现有 `shouldBlockSecretReads` 拦截不变；strict 且 `!complete` → `RESOURCE_LIMIT` 拒绝。
- 命令输出流式路径不动：quarantine 溢出已 fail-closed；capture 限流丢弃的字节不返回、不落盘，不构成泄露面（在 acceptance 记录该论证）。

### 2.3 出口接线

| 出口 | 现状 | 变化 |
|------|------|------|
| `fail()`（result.ts） | message/detail 原样 | message/suggestion 过 `redactText`+2000 字符截断；detail 过 `redactDetail`；`content` 随之净化（单点覆盖全部错误路径） |
| `logger.formatMsg` | 原样内插 | tool/action/detail 过 `sanitizeLogField`（控制字符转义防 log forging） |
| `audit.record` | detail 原样入队 | detail 过 `redactDetail`、`error` 过 `sanitizeLogField`（record 时单点；命令原文不再以未脱敏形态落盘） |
| `session.saveToDisk` | env value + 原始命令 + `.tmp` rename | env 默认 `envKeys`（opt-in 才存 value 且逐 key 过 `persistentEnvValueAllowed`）；history 逐条 `redactCommand`；落盘走 `atomicWriteFile`（0o600） |
| `session` env 判定 | 大小写敏感 | `setEnv`/`sanitizeRestoredEnv` 委托 `validateEnvKeyPolicy`（大小写规范化，`path`/`node_options` 变体拒绝） |
| `context.ts` `last_cmd` | 原文切片 60 | `sanitizeLogField(lastCmd, 64)`（redact + 转义 + 截断）；env keys、cwd 过 `sanitizeLogField` |
| `safeguard.buildRiskMessage` | 命令原文预览 | 预览与 batch 逐条过 `redactText`（confirmation 上下文不回显秘密） |
| `index.ts` fatal | 原始异常 stderr | message 过 `sanitizeLogField`（经 `redactError`） |
| `environment_vars` | 任意值 + 可缓存 | 移出 `CACHEABLE_TOOLS`；`get`/`list` 按 `envValueDisplayAllowed` 掩码/展示，展示值过 `redactText` |

**ResultBoundary 的实现形态**：roadmap 交付项中的 "ResultBoundary" 即 `fail()` 出口单点 redaction（上表第一行）——所有 `ToolError` 的 message/suggestion/detail 在同一处净化，`toCallToolResult` 与成功 envelope 结构不变；命令 stdout/stderr 不在此处二次扫描（流式 matcher 已覆盖）。

**执行链红线**：redaction 只作用于展示、记录与持久化出口；**执行路径（spawn 命令、session env 注入子进程、文件写入内容）保持原文不变**，redactor 永不修改将被执行或写盘的数据本身。

### 2.4 兼容与行为收紧

- 行为收紧（feature 目的，acceptance 记录对比）：`path`/`node_options` 变体 set_env 从"可注入"变"拒绝"；`environment_vars list` 对非白名单 key 从"显示值"变"***"；超大内容在 strict 下 read/write 从"跳过扫描放行"变"拒绝"；不完整扫描内容从"可入缓存"变"不缓存"。
- 兼容保留：旧 session.json（含 env map）恢复走原 sanitize（大小写规范化后仍拒绝 denied key）；`session_state` 输出 schema 不变；`validateEnvKey`/`validateEnvValue` 继续从 utility.ts 导出（委托实现），既有单测导入不受影响。
- 预期测试更新：`tests/unit/tools/system.test.ts` 中 `environment_vars` 的"非敏感名返回明文值/列表保留明文"两条用例按新值展示策略改写（默认 allowlist 下非白名单 key 断言 `***`，并补 `MCP_ENV_VALUE_MODE=full` / allowlist 命中用例）；`tests/unit/session.test.ts` 的 env roundtrip 用例改为"默认不回值 + opt-in 回值"双断言；断言错误 detail/audit 含原始命令或原始秘密文本的用例按 redacted 语义更新。
- 错误码不新增：复用 `SECRET_DETECTED`、`RESOURCE_LIMIT`、`VALIDATION_ERROR`、`PATH_FORBIDDEN`。

## 3. 挂载点

| 文件 | 变更 |
|------|------|
| `src/secret-governance.ts`（新增） | redactor、env policy、`redactError`、新环境变量解析 |
| `src/scan.ts` | `ScanResult.complete/scannedBytes`、前缀扫描 |
| `src/result.ts` | `fail()` 内 redaction 单点 |
| `src/logger.ts` | `sanitizeLogField` 接入 |
| `src/audit.ts` | record 时 redact |
| `src/session.ts` | env 大小写策略、keys-only 持久化、redacted history、`atomicWriteFile` |
| `src/context.ts` / `src/safeguard.ts` / `src/index.ts` | prompt/confirmation/fatal 出口 redact |
| `src/tools/system.ts` / `src/tools/utility.ts` | environment_vars 值展示策略、env key 校验委托 |
| `src/cache.ts` / `src/wrap.ts` | `environment_vars` 移出缓存、complete 准入 |
| `src/tools/files.ts` | strict fail-closed（read/write） |
| `tests/unit/secret-governance.test.ts`（新增）等 | redactor/env/scan-complete/出口快照 |

删除判据：移除 secret-governance.ts、`fail()` 内 redaction 行、各出口接线与 `CACHEABLE_TOOLS` 差异后，feature 完全消失、行为回到现状——挂载点均为显式接线，无隐式扩散。

## 4. 实现维度

- 维度档位：安全性=信任边界最高档（fail-closed 优先、单点收口、决策可测）；健壮性 B+（正则与截断的边界处理）；性能 B（redaction 只在错误/记录/持久化边界，命令输出主路径零新增扫描）。其余走默认档位。
- 不做微重构：`utility.ts`（526 行）偏胖但本 feature 只改其两个校验函数的委托；`session.ts`/`audit.ts`/`logger.ts` 职责单一。超出范围的观察：`utility.ts` 持续承载 6 工具 + 格式化函数，建议后续走 `cs-refactor` 拆分，不阻塞本 feature。
- Windows 特性：文件 mode 在 Windows 为 no-op（Node 只支持只读位），acceptance 明确记录 POSIX-only 收紧；env 大小写规范化正是 Windows 语义的补齐。

## 5. 验收场景

1. `session_state set_env key=path`（及 `PATH`、`Node_Options` 任意大小写）→ `VALIDATION_ERROR` 拒绝；恢复含小写变体的旧 session.json 同样过滤。
2. session.json 默认不含 env value（仅 `envKeys`）与原始命令（history 为 redacted 后文本）；`MCP_SESSION_PERSIST_ENV_VALUES=1` 时非敏感 value 可持久化、denied/sensitive key 仍被剔除。
3. 含 `ghp_…`/`eyJ…`/`user:pass@host`/`BEGIN … PRIVATE KEY` 的命令执行后：audit.jsonl、session history、logger stderr、usage-guide prompt 的 `last_cmd`、risk-gated confirmation 文本中均只出现 `[REDACTED]`，无原文。
4. `execute_command` 触发 `Errors.commandBlocked`/timeout 时，error `detail.command` 为 redacted 文本；error message 无秘密原文。
5. logger detail 携带 `\r\n` 与 ESC 控制字符时输出为转义形态，单字段超 2000 字节被截断。
6. `MCP_SECRETS_SCAN=strict` 下 write/read 超过 4 MiB 扫描能力 → `RESOURCE_LIMIT` fail-closed；cache/默认 tier 下超大内容可写但不入结果缓存。
7. `environment_vars list` 默认：白名单 key（如 `PATH`）显示 redacted 值，其余 `***`；`MCP_ENV_VALUE_MODE=full` 恢复全量（sensitive 仍掩码）；`keys` 全掩码；结果永不进 toolCache。
8. 含 URL credentials 的读内容在 cache 准入扫描命中时被跳过缓存（与现有 `secret_detected` 行为合并验证）。
9. session.json 落盘为 exclusive staging + rename（无并发残留 `.tmp`），POSIX mode 0o600；audit.jsonl append/compact 与 state/logs/temp 目录权限收紧在 POSIX 生效。
10. 既有兼容：全部现有单测/e2e/latency 通过（断言原始秘密文本的既有用例按 redacted 语义更新）；全量 gate、`git diff --check`、YAML 校验通过；`secret-stream.ts`/`secret-registry.ts` 零改动。

## 6. 反向检查与明确拒绝

- 不接受在 secret-governance 复制 secret pattern 定义（唯一来源仍是 secret-registry.ts；redactor 只做 g-flag 克隆）。
- 不接受"redaction 后仍在内存队列保留原文"的半吊子实现：audit record 入队前必须完成净化。
- 不接受把 `FORBIDDEN_ENV_KEYS` 扩表当作本 feature 交付（只做大小写规范化；扩表属安全规则变更需另立授权）。
- 不接受对命令输出流式主路径加二次 whole-string 扫描（流式 matcher 已覆盖；性能红线）。
- 不接受 `MCP_ENV_VALUE_MODE` 非法值静默按 full 处理：非法值按既有配置语义回落 `allowlist` 并 logger.warn。
