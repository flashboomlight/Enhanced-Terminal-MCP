---
doc_type: feature-design
feature: 2026-08-29-search-and-adaptive-correctness
requirement: everything-search-optional
roadmap: production-hardening
roadmap_item: search-and-adaptive-correctness
status: approved
summary: 落地 §5.10 partial-result 契约（complete/warnings/truncated）到 search_files/everything_search/grep_content/list_directory，修复 everything CLI failure 静默 fallback、Unix process_list filter 全量泄露，adaptive timeout 实现真实 P95 并使文档/实现/测试三者一致
tags: [production, hardening, search, partial-result, everything, process-list, adaptive-timeout]
created: "2026-08-29"
last_reviewed: "2026-08-29"
depends_on: [2026-08-28-bounded-command-execution, 2026-08-29-tool-wrapper-and-surface-contract]
---

# search-and-adaptive-correctness 设计

## 0. 术语约定

- **complete**：最终结果集对请求搜索范围的覆盖完整性（§3.1 定义）；`complete=false` 的结果称 **partial**。
- **fallback**：首选执行路径失败后切换到替代路径（Everything CLI → native walk）；fallback 事件一律经 `warnings` 暴露，不参与 complete 判定（替代路径完整走完仍 `complete=true`）。
- **CLI failure / unavailable**：failure = es.exe 已解析但执行失败（timeout / 非零退出 / maxBuffer 截断）；unavailable = es.exe 解析不到（隐式）或完整性校验失败（显式，es-integrity 既有路径）。两者处理路径不同，不得混同。
- **warning**：结构化降级事件 `{code, path?, count?}`，记录不中断主流程的完整性损失；与错误 envelope 互斥（整体失败走 `fail`，无 warnings）。
- **truncated**：结果集数量达到 `max_results` 预算被截断（`truncated=true`）；区别于单条命中内容的每项长度截断（`maxMatchItemChars`，仅在内容末尾附截断标记，不置 `truncated`）。

## 1. 背景与目标

生产硬化 roadmap 第 10 条（模块 search / adaptive / tool-contract）。生产就绪审计中本条负责关闭四个 P2 条目：

- **SEARCH-01**：`everything_search`/`search_files` 的 Everything CLI 超时、退出失败或输出截断处理不当——`search_files` 把 CLI 执行失败与"不可用"混为一谈静默 fallback，`everything_search` 不区分 timeout/maxBuffer/exit code。
- **SEARCH-02**：native search、PowerShell grep 和目录 walk 吞掉权限/遍历错误，返回看似成功的部分结果；响应没有 `complete`/`warnings` 语义，Agent 可能把不完整结果当完整事实。
- **SYS-01**：Unix `process_list` 的 filter 分支先输出未过滤的 `ps aux --sort=-%mem` 再追加过滤结果，filter 存在时泄露全部进程列表；无 filter 分支 `top` 截断在 GNU ps 下不生效；`filter`/`top` 无 finite/bounded 校验。
- **PERF-01**：adaptive timeout 注释写 P95（且 P95×2 与 P95×3 两种说法并存），实现是 `avgLatency × 3`；文档/实现/测试三者不一致。

契约硬约束：

- roadmap §5.10：`SearchResult<T> = { matches, total, truncated, complete, warnings: Array<{code, path?}> }`；no-match、达到结果/遍历/响应预算、权限错误、外部 CLI unavailable、CLI failure 必须分别可观测；任何 fallback 或 `$ErrorActionPreference = 'SilentlyContinue'` 都不能把权限/执行错误伪装成 `complete: true`。
- roadmap §5.3 输入覆盖矩阵"搜索"行与"系统"行：regex/query length、ReDoS、每项长度、遍历/partial-result/response budget、filter/top finite/bounded。
- STATUS.md 坑清单：schema 收紧必须配 handler 层同源校验（直调单测绕过 SDK zod 层）；SDK 1.29 对 v3 ZodEffects 广告空 schema，跨字段校验只能放 handler 层。
- 验收基线（roadmap §6.10）：Everything CLI 失败不会返回假成功；权限/遍历/CLI partial 不会报告 `complete=true`；搜索和 list 参数/每项/响应全量有界；Unix filter 不会先泄露全量 `ps`；adaptive 文档、实现、测试三者一致。

## 2. 现状与差距（证据）

| # | 现状 | 证据 | 差距 |
|---|---|---|---|
| 1 | `search_files` Everything 执行失败被 debug 日志吞掉并静默 native fallback，CLI failure 与 unavailable 同路径 | `src/tools/search.ts:125-128` catch 后仅 `logger.debug("everything-fallback")` | SEARCH-01：CLI failure 不可观测 |
| 2 | `everything_search` catch 一律 `EXECUTION_FAILED`，不区分 timedOut/maxBuffer/exit code；错误消息直接 `errMsg(e)` 携带 ManagedProcessError 全文（含 stdout/stderr 片段） | `src/tools/search.ts:237-240` | SEARCH-01：错误分类缺失 |
| 3 | `everything_search` 输出无 `truncated`/`complete`/`warnings`；CLI `-n maxR` 截断无信号 | `src/tools/search.ts:185-186` outputSchema | §5.10 形状缺失 |
| 4 | `search_files` native walk 的 readdir 错误仅 `logger.warn` 后继续，partial 结果报成功 | `src/tools/search.ts:135-150` | SEARCH-02：吞遍历错误 |
| 5 | `grep_content` PS 脚本 `$ErrorActionPreference='SilentlyContinue'` 吞掉全部遍历权限错误，partial 结果报成功 | `src/tools/search.ts:289` | SEARCH-02：契约点名禁止 |
| 6 | `grep_content` native walk 的 walk-error / grep-file-error 均仅 warn 吞掉；grep 行无每项长度上限（minified 单行可数百 KB） | `src/tools/search.ts:392-413,387` | SEARCH-02 + §5.3 每项长度 |
| 7 | `grep_content` Unix grep `code===1 && stdout 非空` 静默 append 当成功结果 | `src/tools/search.ts:351-358` | SEARCH-02：partial 伪装 complete |
| 8 | `list_directory` 子目录 readdir 错误冒泡整体失败（`mapFsError`），与 search 工具的 partial 语义不一致；无 `complete`/`warnings` | `src/tools/files.ts:296-352` | §5.10 形状缺失（行为二选一待拍板，见 §3.6） |
| 9 | Unix process filter 命令串 `ps aux --sort=-%mem 2>/dev/null \|\| ps aux \| head -n 1; ps aux ...`：第一段成功即全量输出，再 `;` 追加过滤结果 | `src/platform.ts:57-64` | SYS-01：全量泄露 |
| 10 | Unix 无 filter 分支 `ps aux --sort=-%mem` 无 head 截断，`top` 仅在 `--sort` 不支持的 fallback 生效 | `src/platform.ts:66-69` | SYS-01：top 被忽略 |
| 11 | `ProcessListInput` 为裸 `z.string()/z.number()`；`top \|\| 20` 隐式处理 0 | `src/tools/system.ts:91-95,111` | SYS-01：finite/bounded 缺失 |
| 12 | 搜索三工具输入裸 schema：`pattern`/`query` 无长度上限，`max_results`/`max_depth` 无 finite/int 范围 | `src/tools/search.ts:64-69,169-175,246-251` | §5.3 输入矩阵缺口 |
| 13 | adaptive 文件头写"基于 P95"、函数注释写 "P95历史延迟 × 2"、实现 `avgLatency × 3`（上限 4×）；ARCHITECTURE §3.2 写 avg×3、§6 写 P95×3、README 写 P95-based × 3 | `src/adaptive.ts:1-24`；`codestable/architecture/ARCHITECTURE.md:102,198`；`README.md:214` | PERF-01：三方不一致 |
| 14 | telemetry 已保留最近 1000 条原始样本（含 `cacheHit` 标志），具备真实 P95 数据基础；当前只暴露 `avgLatency` 聚合 | `src/telemetry.ts:16-17,28-48,69-82` | PERF-01：真实 P95 可行 |
| 15 | `search_files`/`grep_content`/`list_directory` 在 `CACHEABLE_TOOLS`；缓存写入只看 `result.ok` + secret scan，partial 结果会被缓存并当作完整结果服务后续相同请求 | `src/cache.ts:195-202`；`src/wrap.ts:137-147` | SEARCH-02：partial 不得入缓存（延续 secret-redaction"不完整内容不入缓存"先例） |
| 16 | native walk 不检查 `context.signal`，长遍历无法取消 | `src/tools/search.ts:135-150,392-413` | 遍历预算/取消缺口（roadmap #10 交付点名 native fallback timeout/cancel） |
| 17 | `process_list` 的 `capabilityGate(context, "host-process-inspection")` 已由 #9 接入 | `src/tools/system.ts:108-109` | SYS-01 的 sandboxed 受限视图已覆盖，本条不重复 |

补充事实：`Errors.partialResult`（`PARTIAL_RESULT`，retryable）已在 `src/result.ts:323` 注册，无需新增错误码；Unix spec 分支在 Windows 开发机上不可达（`IS_WIN` 常量），命令串构造需抽纯函数才能跨平台单测。

## 2.5 结构健康度

- 将要改动的文件中 `src/tools/search.ts`（429 行）已偏大。本次新增的 native 遍历 + warnings 收集逻辑若继续塞入会突破一屏函数边界。**做法：新逻辑放两个新文件**——`src/partial-result.ts`（契约类型 + 预算常量 + runtime 校验 helper，预计 <120 行）与 `src/native-search.ts`（native 遍历/逐行 grep + warnings 收集，预计 <150 行），`search.ts` 只保留 schema、CLI 编排与结果组装，净增量控制在既有 handler 内联修改范围。
- `src/platform.ts`（226 行）/`src/system.ts`（348 行）/`src/files.ts`（446 行）/`src/adaptive.ts`（49 行）/`src/telemetry.ts`（141 行）/`src/wrap.ts`（151 行）职责清晰，本次均为局部修改，不做预防性微重构。
- 超出范围的观察（仅提示不阻塞）：`search.ts` 三个 handler 的"try 多层 fallback"结构未来可统一为策略链，属 `cs-refactor` 候选，本条不动。

## 3. 方案设计

### 3.1 partial-result 契约与预算常量（新文件 `src/partial-result.ts`）

名词层唯一定义点：

```ts
export interface SearchWarning { code: string; path?: string; count?: number }

export const WARNING_CODES = {
  EVERYTHING_EXEC_FAILED: "EVERYTHING_EXEC_FAILED",   // CLI failure 已 fallback（search_files）
  WALK_READ_FAILED: "WALK_READ_FAILED",               // 目录遍历 readdir 失败（带 path）
  GREP_FILE_READ_FAILED: "GREP_FILE_READ_FAILED",     // 单文件读取失败（带 path）
  PS_PARTIAL_WALK_ERRORS: "PS_PARTIAL_WALK_ERRORS",   // PowerShell 遍历部分错误（带 count detail）
  GREP_PARTIAL_RESULTS: "GREP_PARTIAL_RESULTS",       // Unix grep 部分结果（exit 1 + 有输出）
  WARNINGS_TRUNCATED: "WARNINGS_TRUNCATED",           // warnings 超上限被截断
} as const;

export const SEARCH_BUDGET = {
  searchFilesMaxResults: 500, everythingMaxResults: 1000, grepMaxResults: 500,
  maxDepth: 32, patternMaxChars: 512, patternMaxBytes: 2048, filePatternMaxChars: 256,
  processTopMax: 100, processFilterMaxChars: 128,
  maxWarnings: 50, maxMatchItemChars: 1000, warningPathMaxChars: 256,
} as const;
```

- `pushWarning(list, {code, path?, count?})`：`path` 截断 256 字符；`list.length >= maxWarnings` 时以末尾一条 `WARNINGS_TRUNCATED` 收尾不再追加。
- `count` 仅 `PS_PARTIAL_WALK_ERRORS` 使用，承载 PS 侧错误合计计数（明细不回传，见 §3.5）；outputSchema 对应 `count: z.number().int().nonnegative().optional()`，不破坏 §5.10 基线形状 `{code, path?}`。
- runtime 校验 helper（与 zod schema 同数值常量，供 handler 层直调路径使用，遵循 #3 `validateBoundedCommandInput` 先例）：`assertIntRange(value, {min,max,param})`、`assertStringBounded(value, {maxChars,maxBytes,param})`，不通过返回 `fail(VALIDATION_ERROR, …)` 否则 `null`；optional 字段为 `undefined` 时跳过校验返回 `null`（schema 侧同样 optional，默认值由 handler 既有 `??` 提供）。字符计数用 code point（`Array.from`，坑清单）。
- 数值拍板依据：上限均取默认值约 10 倍（search_files/grep 默认 50→500；everything 默认 100→1000；depth 默认 5→32；top 默认 20→100）；filter 128 字符对齐 `kill_process` 的 name 边界；预算为启动常量不接环境变量（与 #3 先例一致，见 §9）。
- `complete` 语义定义（本条全项目统一）：**最终结果集对请求搜索范围的覆盖完整性**。fallback/降级事件一律经 `warnings` 暴露；仅当遍历/读取错误导致范围未被完整覆盖时 `complete=false`。例：Everything CLI failure → native fallback 完整走完 → `complete=true` + `warnings=[EVERYTHING_EXEC_FAILED]`；native walk 中一个子目录无权限 → `complete=false` + `warnings=[WALK_READ_FAILED]`。

### 3.2 native 遍历层（新文件 `src/native-search.ts`）

```ts
export interface NativeSearchOutcome { matches: string[]; complete: boolean; warnings: SearchWarning[] }

export async function nativeSearchFiles(
  root: string, nameRegex: RegExp,
  opts: { maxResults: number; maxDepth: number; signal?: AbortSignal },
): Promise<NativeSearchOutcome>;

export async function nativeGrepContent(
  root: string, fileRegex: RegExp, contentRegex: RegExp,
  opts: { maxResults: number; maxDepth?: number; signal?: AbortSignal },
): Promise<NativeSearchOutcome>;
```

- walk 内 `readdir` 失败 → `pushWarning(WALK_READ_FAILED, path)` + `complete=false` + 继续其余分支（不再静默）。
- `nativeGrepContent` 单文件读取失败 → `GREP_FILE_READ_FAILED` + `complete=false` + 继续；每行命中截断 `maxMatchItemChars` 并附 `"…[truncated]"` 标记。
- 每次循环迭代检查 `signal?.aborted`，抛出 `AbortError`（`name === "AbortError"`），由 handler 映射 `CANCELLED`（关闭差距 16）。
- 隐藏目录跳过、`maxResults` 截断语义与现状一致（`search.ts:143,393`），不扩行为。

### 3.3 `search_files` 编排（SEARCH-01 本范围 + §5.10 形状）

现状流程（`search.ts:92-164`）：validatePath → Windows 尝试 Everything（失败静默）→ matches 为空则 native walk → 组装。变化：

- schema 收紧：`pattern: boundedString(patternMaxChars, patternMaxBytes)`、`max_depth: finiteInt(1, 32)`、`max_results: finiteInt(1, 500)`；handler 首行调 `assertIntRange`/`assertStringBounded` 同源二次校验（直调路径）。
- Everything 分支：exec 失败（非 abort）→ `logger.warn` + `pushWarning(EVERYTHING_EXEC_FAILED)` + 继续 native fallback（保留"没有 Everything 也能搜"的产品承诺，但 CLI failure 可观测）；隐式 unavailable 维持 debug + fallback；显式 unavailable 维持 `esResolutionFailure`（现状不动）。
- 三工具 `max_results || 50` 类 falsy 默认值写法统一改 `??`（与 §3.7 `top ?? 20` 一致；双层校验下 0 已被拒，改 `??` 为语义统一与防御性兜底）。
- native 分支改为调用 `nativeSearchFiles`，合并 warnings/complete。
- 输出 `{matches, total, search_ms, truncated, complete, warnings}`：`truncated` 维持 `matches.length >= maxR`；文本段在 warnings 非空时追加一行摘要（如 `Warnings: 2 (first: WALK_READ_FAILED …)`），不泄露超长 path。

### 3.4 `everything_search` 错误分类（SEARCH-01 本范围）

现状流程（`search.ts:192-241`）变化：

- schema 收紧：`query: boundedString(patternMaxChars, patternMaxBytes)`、`max_results: finiteInt(1, 1000)` + handler 同源校验。
- `ManagedProcessError` 分类映射（catch 内）：
  - `e.cancelled` / `context.signal.aborted` → `Errors.cancelled`（现状保持）；
  - `e.timedOut` → `fail(TIMEOUT, "Everything CLI timed out", { retryable: true, suggestion: "narrow the query or retry" })`；
  - 消息匹配 `/maxBuffer|ENOBUFS|ERR_OUT_OF_RANGE/i` → `Errors.resourceLimit("Everything CLI output exceeded buffer", { suggestion: "lower max_results" })`；
  - 其余非零退出 → `fail(EXECUTION_FAILED, "Everything CLI failed", { retryable: true, detail: { exitCode: e.exitCode, signal: e.signal } })`——**不再 `errMsg(e)` 携带 stdout/stderr 全文**（§5.9 detail 有限元；message 仍过统一 redactor 限长）。
- 输出补 `truncated`（`results.length >= maxR`）、`complete: true`、`warnings: []`；no-match（exit 0 空输出）→ `success` 空 matches、`complete: true`，与 CLI failure 明确区分。

### 3.5 `grep_content` 三路径 partial 语义（SEARCH-02 本范围）

- schema 收紧：`pattern: boundedString(patternMaxChars, patternMaxBytes)`（`getRegex` ReDoS 预检保留）、`file_pattern: boundedString(filePatternMaxChars, 1024)`、`max_results: finiteInt(1, 500)` + handler 同源校验。
- **PS 路径**：遍历与匹配两段均挂错误收集——`Get-ChildItem … -ErrorVariable +walkErrs`、`Select-String … -ErrorVariable +grepErrs`（保留 `SilentlyContinue` 让遍历继续；`$MaximumErrorCount` 默认 256 条自带截断，只输出计数不回传明细，无内存风险），末尾按合计计数 `[Console]::Error.WriteLine("ETMCP_PARTIAL_ERRORS=$($walkErrs.Count + $grepErrs.Count)")`（仅当合计>0）；handler 从 `result.stderr` 解析 `ETMCP_PARTIAL_ERRORS=(\d+)` → `pushWarning(PS_PARTIAL_WALK_ERRORS)` + `complete=false`；stderr 其余非空内容仅 debug 日志。技术前提已验证：`PS_UTF8_PREAMBLE`（`src/shell.ts:268-269`）只设编码不写 stderr，`-NoProfile -NonInteractive` 无 profile 噪音。exec 级失败维持 `EXECUTION_FAILED`（现状 `:311-318` 已正确）。
- **Unix grep 路径**：exit 1 + 空 stdout → no-match（`complete=true`，现状）；非零退出 + 有 stdout（GNU/BSD grep 遍历中部分文件不可读均以此形态返回：GNU exit 2、BSD exit 1/2）→ append 结果 + `GREP_PARTIAL_RESULTS` + `complete=false`；exit 2 且无 stdout → `EXECUTION_FAILED`。
- **native 路径**：改调 `nativeGrepContent`，合并 warnings/complete。
- 输出 `{matches, total, search_ms, truncated, complete, warnings}`（`truncated` 新增，`results.length >= maxR`）。

### 3.6 `list_directory` partial 语义（SEARCH-02 本范围，行为变化拍板）

- 现状：子目录 `readdir` 错误冒泡 → `mapFsError` 整体失败。**拍板改为 partial**：顶层 `readdir` 失败仍整体失败（请求目标本身不可读，无结果可给）；递归子目录 `readdir` 失败 → `pushWarning(WALK_READ_FAILED, path)` + `complete=false` + 继续其余分支。理由：与三个搜索工具的 §5.10 语义一致；大型目录树下单一无权限子目录不应使整次列举失败，且 `complete=false` 已防止误当完整事实。
- `max_depth: finiteInt(1, 32)` + handler 同源校验。
- 单项 `stat` 失败维持静默降级（无 `size_bytes` 的 entry，不影响范围覆盖完整性，记 warning 会产生噪音）；`realpath` 失败降级维持（防 symlink 循环辅助）。
- 输出 `{entries, total, truncated, complete, warnings}`。

### 3.7 `process_list` Unix 修复（SYS-01）

- `src/platform.ts`：Unix 命令串构造抽为导出纯函数（`IS_WIN` 不敏感，跨平台可单测）：

```ts
export function buildUnixProcessListCommand(filter: string | undefined, top: number): string;
```

  - 无 filter：`ps aux 2>/dev/null | head -n 1; ps aux 2>/dev/null | tail -n +2 | sort -k4,4 -rn | head -n ${top}`
  - filter：`ps aux 2>/dev/null | head -n 1; ps aux 2>/dev/null | tail -n +2 | grep -i -- '${safeFilter}' | grep -v grep | sort -k4,4 -rn | head -n ${top}`
  - 先筛选再排序截断；不再使用 GNU `--sort` 扩展（macOS/BSD 一致）；`%MEM` 为 `ps aux` 第 4 列（两平台一致）；两次 `ps` 快照的瞬态差异可接受（进程列表本为瞬态视图）；`safeFilter` 维持 `sanitizeProcessName` + 单引号包裹，top 为已校验 int。
- `src/tools/system.ts`：`top: finiteInt(1, 100)`、`filter: boundedString(128, 512)` + handler 同源校验；`top || 20` 改 `top ?? 20`。
- Windows PowerShell 分支不动（无泄露问题）；capability gate 已由 #9 覆盖（差距 17），不重复。

### 3.8 adaptive timeout 真实 P95（PERF-01）

- `src/telemetry.ts` 新增：

```ts
/** 指定工具最近窗口内的非 cache-hit 延迟样本（ms）；cache 命中不代表真实执行延迟，不计入 */
latencySamples(toolName: string): number[];
```

- `src/adaptive.ts`：`adaptiveTimeout` 改为 `max(base, min(round(P95 × 3), base × 4))`；样本 `< 5` 回退 `base`（现状门槛保持）；P95 取排序后第 `ceil(0.95 × n)` 个（nearest-rank）。系数 ×3 与上限 ×4 不变——README 与 ARCHITECTURE §6 已宣称 "P95-based × 3 / P95×3，上限 4×"，选真实 P95 后这两处**无需改动**，实现向文档对齐。
- 修正 `adaptive.ts` 文件头与函数注释（删除 "P95 × 2" 错误表述，写明 nearest-rank P95×3 + 上限 + 样本门槛）；ARCHITECTURE §3.2 `adaptive.ts` 行由 "avg×3" 改 "P95×3（样本<5 回退默认）"（验收回写时落）。
- 性能：调用点唯一（`execute_command` 未显式 `timeout` 时，`src/tools/command.ts:433`），每次 filter ≤1000 条 + sort ≤1000 条为微秒级，不加缓存。

### 3.9 partial 结果不入缓存（SEARCH-02 收尾）

- `src/wrap.ts` 缓存写入条件追加：`result.structured?.complete !== false`（仅当 structured 为对象且显式 `complete: false` 时跳过；无该字段的既有工具行为不变）。
- 与现有 secret scan `safe && complete` 并列；错误结果本就不缓存，无脏缓存面。
- `everything_search` 不在 `CACHEABLE_TOOLS`，无缓存面。

## 4. 挂载点

| 文件 | 变更 |
|------|------|
| `src/partial-result.ts`（新增） | `SearchWarning`/`WARNING_CODES`/`SEARCH_BUDGET`/`pushWarning`/`assertIntRange`/`assertStringBounded`——契约类型与预算常量唯一来源 |
| `src/native-search.ts`（新增） | `nativeSearchFiles`/`nativeGrepContent`——native 遍历 partial 语义、walk 错误收集、signal 检查、命中行截断 |
| `src/tools/search.ts` | 三工具 schema 收紧 + handler 同源校验；warnings/complete/truncated 接线；Everything CLI failure warning 与 everything_search 错误分类 |
| `src/tools/files.ts` | `list_directory` 子目录 partial 语义 + `max_depth` 校验 |
| `src/platform.ts` | `buildUnixProcessListCommand` 纯函数抽出；`getProcessListSpec` Unix 分支换用 |
| `src/tools/system.ts` | `ProcessListInput` 收紧 + handler 同源校验；`top ?? 20` |
| `src/telemetry.ts` | `latencySamples(toolName)`（排除 cache-hit 样本） |
| `src/adaptive.ts` | 真实 P95 实现 + 文件头/函数注释修正 |
| `src/wrap.ts` | 缓存写入条件追加 `structured.complete !== false` |
| `tests/unit/partial-result.test.ts`、`native-search.test.ts`（新增）；`tools/search.test.ts`、`tools/files.test.ts`、`tools/system.test.ts`、`platform`、`adaptive`、`wrap` 测试（新增或扩展） | 覆盖见 §8 测试矩阵 |

## 5. 实现维度

- 维度档位：B+——两个新模块（契约/遍历层）+ 七个既有文件局部接线；无执行链与安全核心改动；错误码全部复用现有，无新增对外面。
- 推进策略（paradigm 切片，每步独立可验）：
  1. **编排骨架**：`partial-result.ts` + `native-search.ts` 先行落地，不依赖任何 handler 改动。退出信号：`pnpm exec tsc --noEmit` 绿 + 两模块单测绿。
  2. **计算节点**：`telemetry.latencySamples`、`adaptive` P95、`platform.buildUnixProcessListCommand`——纯逻辑无 I/O 编排。退出信号：tsc 绿 + adaptive/platform 单测绿（偏斜分布、Unix 命令串形状）。
  3. **接线**：四工具 handler（search×3/files）+ system 校验 + wrap 缓存门禁。退出信号：tsc 绿 + tools 层单测绿（mock execFileManaged 错误分类、partial 语义、校验拒绝）。
  4. **测试加固与门禁**：e2e 回归 + 覆盖率。退出信号：`pnpm run gate` 全绿。
- 兼容风险最高点：行为变化 5/6/7（partial 从静默变显式）与行为变化 11（输入收紧）——前者是 feature 目的而非回归；后者为安全收紧，默认值不变。两者均写入 CHANGELOG 行为变化节；e2e 断言只新增字段不删旧字段（§8 回归行）。

## 6. 配置表

无新增环境变量。搜索/进程预算为启动常量（`SEARCH_BUDGET`，§3.1），不接配置面（与 #3 `bounded-command-execution` 先例一致；若未来统一接 profile 配置面，属独立 feature）。

## 7. 行为变化表

| # | 场景 | 变更前 | 变更后 |
|---|---|---|---|
| 1 | `search_files` 的 Everything CLI 超时/崩溃/截断 | debug 日志后静默 native fallback，用户无感知 | fallback 保留 + `warnings=[EVERYTHING_EXEC_FAILED]` |
| 2 | `everything_search` CLI timeout | `EXECUTION_FAILED`（消息含 stdout/stderr 全文） | `TIMEOUT`（有限 detail） |
| 3 | `everything_search` 输出超 maxBuffer | 同上 | `RESOURCE_LIMIT` + 降 max_results 建议 |
| 4 | `everything_search` CLI 非零退出 | 同上 | `EXECUTION_FAILED` + `{exitCode, signal}` 有限 detail |
| 5 | 搜索/list 遍历中子目录无权限 | search/grep：静默吞掉报成功；list：整体失败 | `complete=false` + `warnings=[WALK_READ_FAILED]`，其余分支结果照常返回 |
| 6 | `grep_content` PS 遍历部分权限错误 | SilentlyContinue 静默吞掉 | `complete=false` + `warnings=[PS_PARTIAL_WALK_ERRORS]` |
| 7 | `grep_content` Unix grep 非零退出 + 有输出（遍历部分文件不可读） | 静默当完整结果 | `complete=false` + `warnings=[GREP_PARTIAL_RESULTS]` |
| 8 | `grep_content` 命中行极长（minified 单行） | 原样进入响应 | 每行截断 1000 字符 + 截断标记 |
| 9 | Unix `process_list` 带 filter | 先全量 `ps aux` 泄露再追加过滤结果 | 表头 + 先筛选再按 %MEM 倒序截断 top N |
| 10 | Unix `process_list` 无 filter | GNU ps 下 `top` 被忽略，全量输出 | 统一 tail+sort+head，`top` 恒生效 |
| 11 | `process_list` `top=0/-1/101`、`filter` 超长；搜索工具 `max_results`/`max_depth` 越界、`pattern` 超长 | 裸 schema 接受或隐式 `\|\|` 处理 | `VALIDATION_ERROR`（schema + handler 同源双层） |
| 12 | partial（`complete=false`）搜索/list 结果 | 进入 LRU 缓存服务后续相同请求 | 不缓存（下次请求重新执行） |
| 13 | `adaptiveTimeout("execute_command")` | `avg×3`（上限 4×base） | 非 cache-hit 样本 P95×3（上限 4×base，样本<5 回退 base） |
| 14 | 输出 structured 形状 | 各工具仅 matches/total/(truncated)/search_ms | 四工具统一补 `complete`/`warnings`（everything/grep 补 `truncated`）；新增字段向后兼容，错误 envelope 不变 |

## 8. 测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| unit | `tests/unit/partial-result.test.ts`（新增） | pushWarning 上限/截断标记/path 截断；assertIntRange/assertStringBounded 边界（0、负、超界、超长、code point 计数） |
| unit | `tests/unit/native-search.test.ts`（新增） | 正常遍历 complete=true；root 为文件触发 readdir 失败 → complete=false + WALK_READ_FAILED；grep 行截断；signal abort → AbortError；隐藏目录跳过 |
| unit/tools | `tests/unit/tools/search.test.ts`（扩展） | 输入校验越界 → VALIDATION_ERROR；grep/search 输出含 complete/warnings/truncated；`vi.mock` execFileManaged 模拟 Everything timeout/maxBuffer/exit≠0 → 错误分类映射；CLI failure → fallback + warning；PS stderr 标记解析（构造 result.stderr） |
| unit/tools | `tests/unit/tools/files.test.ts`（扩展） | list_directory 子目录不可读 → partial + warnings（root 保持整体失败）；max_depth 越界校验 |
| unit | `tests/unit/platform.unix.test.ts`（新增或扩展既有 platform 单测） | `buildUnixProcessListCommand`：filter 分支不含未过滤全量段、含 `tail -n +2`/`grep -i`/sort/head 顺序；无 filter 分支 top 截断；sanitize 后空 filter 回落无 filter 分支 |
| unit/tools | `tests/unit/tools/system.test.ts`（扩展） | process_list top/filter 越界 → VALIDATION_ERROR（直调路径） |
| unit | `tests/unit/adaptive.test.ts`（新增或扩展） | 偏斜分布（18×10ms + 2×5000ms，n=20）→ nearest-rank 第 19 名 P95=5000；defaultMs=5000 → 15000（P95×3 生效）；defaultMs=1000 → 4000（上限 4×base 截断）；defaultMs=30000 → 30000（base 兜底）；均匀分布；样本<5 回退；cache-hit 样本被排除 |
| unit | `tests/unit/wrap.test.ts`（扩展） | structured.complete=false → 不缓存；complete=true/无字段 → 照常缓存 |
| e2e | `tests/e2e-latency.test.ts`（回归） | 现有搜索/list/process 用例保持绿；structured 断言仅新增字段不删旧字段 |
| gate | `pnpm run gate` | build + tsc + lint + test + latency + tools coverage |

## 9. 明确不做

- 预算常量不接环境变量 / profile 配置面（与 #3 先例一致，统一配置面属独立 feature）。
- 不改动 Windows PowerShell `process_list` 分支与 `capabilityGate`（#9 已接线，sandboxed 受限视图不重复）。
- 不重构 `search.ts` 的多层 fallback 结构为策略链（§2.5 观察项，归 `cs-refactor` 候选）。
- 不改变 `CACHEABLE_TOOLS` 名单、TTL 与缓存 key 语义；不动 `ProcessPool` stub。
- 不引入真实 P95 以外的 telemetry 聚合面（histogram/滑动窗口持久化等均不做）。
- 不升级 SDK、不使用 schema 层 refine/discriminated union（SDK 1.29 约束，#9 已记录）。
- 不动 `es-integrity` 解析链与 SHA-256 锁定；Windows grep 的 Select-String 匹配语义不调整。
- `everything_search` 仍仅 Windows；不为 Unix 提供替代实现。

## 10. 验收标准映射（roadmap §6.10）

| 验收句 | 落点 |
|---|---|
| Everything CLI 失败不会返回假成功 | §3.4 错误分类 + §3.3 fallback warning + tools 层 mock 单测 |
| 权限/遍历/CLI partial 不会报告 `complete=true` | §3.1 complete 语义 + §3.2/3.5/3.6 warnings 收集 + native-search/files 单测 |
| 搜索和 list 参数/每项/响应全量有界 | §3.1 预算 + schema/handler 双层校验 + §3.2 每项截断 + wrap 响应兜底（#9 已有） |
| Unix filter 不会先泄露全量 `ps` | §3.7 spec 重写 + 命令串纯函数单测 |
| adaptive 文档、实现、测试三者一致 | §3.8 真实 P95 + 注释/ARCHITECTURE 统一 + 偏斜分布单测 |
| CLI error/no-match/partial truth（roadmap §8 表行） | §3.4 no-match 空结果 vs 错误分类；§3.3/3.5 partial warnings |
| 关闭审计 SEARCH-01/SEARCH-02/SYS-01/PERF-01 | §3.3–3.5 / §3.2+3.5+3.6+3.9 / §3.7 / §3.8 |

## 11. 风险与缓解

- **PS stderr 标记与既有输出混淆**：标记前缀 `ETMCP_PARTIAL_ERRORS=` 唯一；pwsh/5.1 invocation 的 UTF-8 preamble 不写 stderr（`src/shell.ts` 既有行为）；未知 stderr 仅 debug 日志不影响 complete 语义。
- **Unix spec 在 Windows 开发机不可达**：命令串构造抽纯函数（§3.7）单测固化；真实 Unix 行为依赖 CI/后续 cross-platform smoke（#12 范围），本条在验收风险中显式声明。
- **`sort -k4,4 -rn` 对非数值列的鲁棒性**：`ps aux` 第 4 列 `%MEM` 在两平台均为数值；表头经 `tail -n +2` 排除，不进入排序。
- **complete=false 不缓存导致重复遍历开销**：仅 partial 结果不缓存（权限错误通常持续存在，30s TTL 内重复遍历成本可接受）；complete=true 路径缓存行为不变。
- **P95 切换后超时变宽**：偏斜历史下 P95×3 > avg×3，超时更宽松是契约意图（避免误杀长尾）；上限 4×base 不变，不会无界放宽。
- **行为变化 11（输入收紧）的兼容性**：越界输入从"静默接受"变 `VALIDATION_ERROR`，属安全收紧；默认值不变，正常客户端无感知。写入 CHANGELOG 行为变化节。
- **`search_files` Everything 路径 `-n maxR*2` 拉取的截断漏报**：dir 内匹配超过 `maxR*2` 的极端场景下，CLI 侧截断后本地过滤可能 `< maxR` 而使 `truncated=false` 漏报。这是现状既有近似（不回归），本条维持；彻底修复需向 es.exe 传目录限定查询而非本地过滤，属独立优化。
- **PS `-ErrorVariable` 只收集非终止错误**：`SilentlyContinue` 下遍历/读取错误均入变量（已验证语义）；终止性错误仍会走 exec 级失败（`EXECUTION_FAILED`），两条路径不冲突。
