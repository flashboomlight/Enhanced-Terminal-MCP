---
doc_type: acceptance
slug: search-and-adaptive-correctness
status: done
created: 2026-08-29
last_reviewed: 2026-08-29
tags: [production-hardening, search, partial-result, adaptive-timeout, process-list]
roadmap: 2026-08-28-production-hardening#10
related_architecture: [enhanced-terminal]
---

# Acceptance · search-and-adaptive-correctness（production-hardening #10）

## 1. 交付映射

| 设计交付 | 落地 | 验证 |
|---|---|---|
| `src/partial-result.ts`（SearchWarning/WARNING_CODES/SEARCH_BUDGET/pushWarning/assert 同源校验/searchWarningSchema） | 新模块 ~150 行；warnings 上限 50 条以 WARNINGS_TRUNCATED 收尾、path code-point 截 256；assertIntRange/assertStringBounded 返回 `Errors.validationError`，undefined 跳过 | `tests/unit/partial-result.test.ts` 15 例（上限/截断/count/边界 test.each/emoji code point 与字节双口径） |
| `src/native-search.ts`（nativeSearchFiles/nativeGrepContent 返回 `{matches,complete,warnings}`） | walk readdir 失败 → WALK_READ_FAILED + complete=false 继续；单文件读取失败 → GREP_FILE_READ_FAILED（AbortError 重抛）；命中行 >1000 code point 截断附 `…[truncated]`；每次迭代 throwIfAborted；隐藏目录跳过语义不变 | `tests/unit/native-search.test.ts` 7 例（root 为文件/隐藏目录/AbortError/行截断/grep 命中） |
| adaptive 真实 P95 | `telemetry.latencySamples(toolName)` 排除 cacheHit 样本；`adaptiveTimeout` 改 nearest-rank P95×3（上限 4×base、样本 <5 回退 base），文件头与函数注释统一为 P95×3 表述 | `tests/unit/adaptive.test.ts` 6 例（偏斜 18×10+2×5000 → P95=5000 → 15000/上限 4000/兜底 30000；均匀分布；cache-hit 排除；未知工具回退） |
| Unix process_list spec 重写 | `platform.ts` 新增纯函数 `buildUnixProcessListCommand(filter, top)`：先 `grep -i` 筛选再 `sort -k4,4 -rn` 再 `head` 截断，去掉 GNU `--sort=-%mem` 与未过滤全量段；sanitize 后空 filter 回落无 filter 分支；`getProcessListSpec` Unix 分支换用，Windows 分支不动 | `tests/unit/platform.unix.test.ts` 新增 3 例（命令串形状断言，含无 `--sort=-%mem`/无 `|| ps aux` 反断言） |
| search 三工具 partial-result 契约 | schema 收紧（pattern/query/file_pattern boundedString、max_results/max_depth finiteInt）+ handler 首行同源校验；search_files Everything exec 失败 → warn + EVERYTHING_EXEC_FAILED + native fallback；everything_search 错误分类（timedOut→TIMEOUT、maxBuffer→RESOURCE_LIMIT、其余 ManagedProcessError→EXECUTION_FAILED 有限 detail `{exitCode,signal}`）；PS grep 两段 `-ErrorVariable` 合计 `ETMCP_PARTIAL_ERRORS=N` 经 stderr 回传解析；Unix grep 非零退出+有输出 → GREP_PARTIAL_RESULTS；三工具输出补 truncated/complete/warnings | `tests/unit/tools/search.test.ts` 新增 9 例（越界 VALIDATION_ERROR ×3、mock execFileManaged 错误分类 ×3、no-match 空结果、CLI failure fallback、PS stderr 标记解析），既有 8 例零回归 |
| list_directory partial 语义 | 顶层 readdir 失败仍整体失败（mapFsError），递归子目录失败 → WALK_READ_FAILED + complete=false 继续；max_depth finiteInt(1,32) + handler 同源校验；输出补 complete/warnings | `tests/unit/tools/files.test.ts` 新增 4 例（子目录不可读 partial、root 整体失败、max_depth 越界 ×2、clean listing complete=true），既有 16 例零回归 |
| process_list 输入收紧 | `top: finiteInt(1,100)`、`filter: boundedString(128,512)` + handler 同源校验（capabilityGate 之后、spawn 之前）；`top \|\| 20` → `top ?? 20` | `tests/unit/tools/system.test.ts` 新增 3 例（top=0/101、filter 129 → VALIDATION_ERROR 直调路径，不真实 spawn） |
| partial 结果不入缓存 | `wrap.ts` 缓存写入条件追加 `structured.complete !== false`；无 complete 字段的既有工具行为不变 | `tests/unit/wrap.test.ts` 新增 2 例（complete=false 不缓存、complete=true 照常缓存） |

## 2. 验收场景（roadmap #10 验收句逐条）

1. **Everything CLI 失败不会返回假成功**：`everything_search` 对 ManagedProcessError 三分支映射——timedOut → `TIMEOUT`（retryable + suggestion）、message 含 maxBuffer/ENOBUFS/ERR_OUT_OF_RANGE → `RESOURCE_LIMIT`（suggestion: lower max_results）、其余 → `EXECUTION_FAILED` 且 detail 仅 `{exitCode,signal}`（不携带 stdout/stderr 全文）；`search_files` CLI 失败记 `EVERYTHING_EXEC_FAILED` warning + logger.warn 后走 native fallback，native 完整走完 `complete=true`。mock 单测逐分支固化。
2. **权限/遍历/CLI partial 不会报告 `complete=true`**：native walk readdir 失败、PS 遍历/匹配非终止错误（`-ErrorVariable` 合计经 stderr 标记回传）、Unix grep 非零退出+有输出、list_directory 递归子目录不可读四条路径均 `complete=false` + 对应 warning code（WALK_READ_FAILED/PS_PARTIAL_WALK_ERRORS/GREP_PARTIAL_RESULTS），结果文本段附 `Warnings: N (first: CODE)`；partial 结果（complete=false）不写入 LRU 缓存，complete=true 或无字段工具缓存行为不变。
3. **搜索和 list 参数/每项/响应全量有界**：pattern/query 512 字符 + 2048 字节、file_pattern 256 字符、max_results/max_depth/top finiteInt 区间、filter 128 字符——schema（finiteInt/boundedString）与 handler（assertIntRange/assertStringBounded 同源）双层生效，直调路径越界一律 `VALIDATION_ERROR` 带 param；grep 命中行 >1000 code point 截断附标记；warnings 收集上限 50 条以 WARNINGS_TRUNCATED 收尾、warning path 截 256；响应字节兜底沿用 #9 `MCP_RESPONSE_MAX_BYTES`。
4. **Unix filter 不会先泄露全量 `ps`**：`buildUnixProcessListCommand` 命令串为 `表头; ps aux | tail -n +2 | [grep -i -- '<filter>' | grep -v grep |] sort -k4,4 -rn | head -n <top>`——filter 存在时不存在任何未过滤全量输出段（反断言无 `--sort=-%mem`、无 `|| ps aux`）；无 filter 分支 top 恒生效（不依赖 GNU 扩展）；sanitize 后空 filter 回落无 filter 分支。
5. **adaptive 文档、实现、测试三者一致**：实现改 nearest-rank P95×3（非 cache-hit 样本，样本 <5 回退 base，上限 4×base）；偏斜分布（18×10ms+2×5000ms，n=20）P95=5000 → 超时 15000（base 5000）/4000（base 1000 触发上限）/30000（base 30000 触发兜底）；adaptive.ts 注释、ARCHITECTURE §3.2 行（avg×3 → P95×3）、README（原已写 P95×3）三者统一。
6. **CLI error/no-match/partial truth**：everything_search no-match（exit 0 空输出）返回空 matches + `complete:true` + `truncated:false` + `warnings:[]`，与 CLI failure 错误明确区分；四工具输出统一含 complete/warnings（everything/grep 补 truncated），新增字段向后兼容、不删旧字段，错误 envelope 不变。

## 3. 实现期审计与修正

| 轮次 | 发现 | 修正 |
|---|---|---|
| 设计 Round 1-3 | PS `-ErrorVariable` 追加语义、stderr 标记可行性、P95 与缓存交互、Unix spec 纯函数化 | design 多轮自审后定稿（bundled pwsh 7.6.5 实测 `+walkErrs/+grepErrs` 追加、`[Console]::Error.WriteLine` 进 stderr 语义确认） |
| 实现 Round A | P95 测试矩阵算术错误：19×10+1×5000（n=20）nearest-rank 第 19 名落在 10ms 而非 5000 | 改 18×10+2×5000（P95=5000 成立），design §8 测试矩阵与 checklist 同步修正 |
| 实现 Round B | Unix grep partial 判定初稿写"exit 1+有输出"，但 GNU grep 权限 partial 是 exit 2（exit 1 仅 no-match） | 改"非零退出 + 有 stdout → GREP_PARTIAL_RESULTS"，design/checklist 同步 |
| 实现 Round C | biome `noImplicitAnyLet` 三处（native-search ×2、files ×1 的 `let entries`） | 补 `Dirent[]` 显式标注，lint 归零 |
| 实现 Round D | e2e 兼容预判：structured 新增 complete/warnings/truncated 字段可能撞既有精确断言 | 全量 e2e 实跑零回归（既有断言均为 toMatchObject/字段级，未对整个 structured 做精确 toEqual），无需改断言 |

## 4. 行为收紧汇总（对外可见）

- `everything_search` CLI 超时/输出截断/非零退出从"可能假成功空结果"变为 `TIMEOUT`/`RESOURCE_LIMIT`/`EXECUTION_FAILED` 结构化分类（关闭审计 SEARCH-01）；
- search/list 遍历与读取错误从"静默吞掉报成功"变为 `complete=false` + `warnings[]` 结构化暴露（关闭审计 SEARCH-02）；
- search/list/process 越界参数从"静默接受"变为 `VALIDATION_ERROR`（schema + handler 同源双层，直调路径不绕过）；
- Unix `process_list` filter 分支从"先输出未过滤全量 `ps aux --sort=-%mem`"变为"先筛选再排序截断"（关闭审计 SYS-01）；
- adaptive timeout 从聚合平均 `avg×3` 变为真实 nearest-rank `P95×3`（关闭审计 PERF-01）；
- partial（complete=false）搜索/list 结果不再写入共享 LRU 缓存；
- search_files/everything_search/grep_content/list_directory 输出新增 `complete`/`warnings`（搜索三工具另补 `truncated`）——纯新增字段，向后兼容。

## 5. 门禁证据（最终全量，2026-08-29）

- `pnpm run gate` → **EXIT=0**（build → tsc → lint → test → latency → tools coverage 全链）
- 全量测试：**66 文件 / 835 用例全过**（新增 partial-result 15 + native-search 7 + adaptive 6 + platform.unix 3 + search 9 + files 4 + system 3 + wrap 2；复跑确认 EXIT=0）
- latency 基准：**24/24 passed**（search_files 5ms / grep_content 809ms / process_list 904ms，均远低于阈值）
- tools coverage（阈值 55/45/60/55）：**64.72 / 54.39 / 71.42 / 68.52 达标**
- lint：0 error（9 warning 均为既有历史告警，与本次改动无关）
- 临时目录：`TEMP/TMP/TMPDIR` 全程显式指向 `D:/ALL MCP/Enhanced Terminal MCP/.etmcp/test-tmp`，无 C 盘写入
- **既有 flake 记录（非本 feature 改动面）**：门禁第 3 次运行 `tests/unit/lock-lease.test.ts` heartbeat 时序用例在高负载下竞争失败 1 次、第 4 次运行 `tests/unit/paging.test.ts` 撞 Windows rename EPERM 1 次（审计文档 §3 已标注的 rename 已知 flake）；两文件均不在本 feature 改动清单内，单独运行均通过，全量复跑 835/835 绿。

## 6. 遗留与归属

- **`search_files` Everything 路径 `-n maxR*2` 截断近似**：dir 内匹配超 `maxR*2` 时 CLI 侧截断可能使 `truncated` 漏报（现状既有近似，未回归；彻底修复需目录限定查询，属独立优化，design §11 已记录）。
- **Unix process_list 真实行为**：命令串形状由纯函数单测固化；真实 Unix 执行依赖 #12 cross-platform smoke（design §11 已声明）。
- **TTL/rename 测试 flake 加固**（fake timers/宽裕 TTL/rename 有界 retry）：审计 §3 既有建议，归 #12 security-and-mcp-conformance-gates 评估。
- **usage-guide "NEW in v3.1" 过期文案**：仍归 #13 docs-and-architecture-closeout。
