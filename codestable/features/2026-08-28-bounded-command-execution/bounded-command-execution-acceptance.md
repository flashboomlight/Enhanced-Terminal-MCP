---
doc_type: feature-acceptance
feature: 2026-08-28-bounded-command-execution
requirement: ""
roadmap: production-hardening
roadmap_item: bounded-command-execution
status: done
summary: 对照设计完成验收；三个命令工具接入 finite/bounded schema 与 handler 二次校验，batch parent BudgetAccount 落地（聚合预检/output 配额/deadline 分类），两轮审计后 10 checks 全部通过，全量 658 用例与完整门禁全绿
tags: [production, hardening, command, schema, budget, batch, acceptance]
created: "2026-08-28"
last_reviewed: "2026-08-28"
---

# bounded-command-execution 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-28
> 关联方案 doc：`codestable/features/2026-08-28-bounded-command-execution/bounded-command-execution-design.md`
> 关联 checklist：`codestable/features/2026-08-28-bounded-command-execution/bounded-command-execution-checklist.yaml`
> 验收授权：用户已明确本轮由代理代为执行 CodeStable 全流程（含 commit 决策）；本报告按当前代码、静态检查、单元与工具层测试和完整质量门禁完成终审记录。

## 1. 接口契约核对

- [x] `src/command-budget.ts`（新增）：`MAX_COMMAND_CHARS/MAX_COMMAND_BYTES/MAX_COMMAND_TIMEOUT_MS/MAX_WATCH_DURATION_MS/MAX_BATCH_ITEMS/MAX_BATCH_INPUT_BYTES/MAX_BATCH_WALLTIME_MS/MAX_BATCH_OUTPUT_BYTES` 启动常量；`buildBatchBudget(signal, overrides)` 构建 `BudgetAccount("batch")` 并链接 context cancellation，`overrides` 仅供测试注入；`commandInputBytes`；`commandBudgetSkipReason`；`validateBoundedCommandInput`。模块无命令执行副作用。
- [x] `execute_command`：`command: boundedString(65536, 131072).optional()`、`timeout: finiteInt(1, 3_600_000).optional()`；handler 层 `validateBoundedCommandInput` 二次校验。
- [x] `batch_execute`：`commands: boundedArray(boundedString(...), 100)`；handler 层二次校验 + 聚合预检 + parent budget。
- [x] `watch_command`：`command: boundedString(...)`、`duration: finiteInt(1, 600_000).optional()`；handler 层二次校验。
- [x] `result.ts`：`BatchSkipReason = "stop_on_error" | "budget_deadline" | "budget_input" | "budget_output"` 类型联合与 `skippedBatchSchema` 的 `z.enum` 同步；`stop_on_error` 原语义不变。

## 2. 行为核对（10 checks）

- [x] 非有限值（Infinity/NaN）、0、负数、超上限 timeout/duration 在副作用前被拒（schema 层给 MCP 客户端 invalid params；handler 层对 direct call 返回 `VALIDATION_ERROR`）——单测 8 个负路径断言 + 工具层 5 个场景。
- [x] 超长 command 按字符（65536，Unicode code point）与字节（131072，UTF-8）双限拒绝；schema 层 `boundedString` 与 handler 层 validator 计数方式同源。
- [x] batch 超 100 条或单项超限被拒；聚合输入超 2MiB 返回 `RESOURCE_LIMIT`（retryable，detail 携带 limit/total）且零命令执行。
- [x] batch parent budget：worker 调度前检查 abort；output 配额按 `total_output_bytes` 逐条 reserve，耗尽后剩余命令 `budget_output` skipped、已完成命令如实保留、`all_ok=false`。
- [x] deadline 到点（deadline timer unref 不持进程）后 worker 停止调度，剩余命令 `budget_deadline` skipped；外部取消仍走 `stop_on_error`/CANCELLED 既有语义，不在预算层重复归类。
- [x] parallel 子任务经 `BudgetAccount.child()` 共享 parent ledger；并发 reserve 原子测试证明 50 个并发 30-byte 预留恰好接受 33 个、余额不足 30，无超发。
- [x] 普通命令兼容：echo、短 batch（skipped 计数器测试）、watch 短时长、cache 读取、中文解码、secret 抑制等既有 29 用例全部不变；e2e/latency 全过。
- [x] 不触碰安全核心：`DANGEROUS_PATTERNS`/`HARD_BLOCK_PATTERNS`/`hardBlock`/safeguard/command policy 零改动（git diff 范围核对）。
- [x] 无新环境变量：预算全部为启动常量；配置面留给后续 profile/backend feature。
- [x] build、`tsc --noEmit`、lint 0/0、全量 52 文件 658 用例、latency 24/24、tools coverage 59.74/48.90/66.32/63.73（底线 55/45/60/55）、`git diff --check`、CodeStable YAML 校验全部通过。

## 3. 实现维度核对

- [x] 预算逻辑集中在 `command-budget.ts`，command.ts 仅在 3 个 schema 段、3 个 handler 校验行和 batch 的预算接线点增量；未把 command.ts 继续做大。
- [x] `budget_input` skip 为防御分支：聚合预检已保证顺序/并发累计 reserve 不会失败（累计 ≤ 总和 ≤ max）；比照 supervisor 容量双检查先例保留，语义由单元测试覆盖。
- [x] output 聚合配额（100MiB）与 batch deadline（10min）在 handler 级不可实测（常量），由单元测试证明 reserve 失败语义、deadline abort 分类与 `fillSkipReason` 优先级（stop_on_error → budget_output → budget_deadline），并经代码审查覆盖 worker 插入点。

## 4. 验证证据

- `pnpm run build`：通过。`pnpm exec tsc --noEmit`：通过。`pnpm run lint`：0 errors, 0 infos。
- `pnpm test`：52 文件 658 用例全部通过（新增 `command-budget.test.ts` 13 用例、`tools/command.test.ts` bounded 6 场景）。
- `pnpm run test:latency`：24/24 达标。
- `pnpm run test:coverage:tools`：Statements 59.74%、Branches 48.90%、Functions 66.32%、Lines 63.73%，均高于底线；tools 7 文件 61 用例全过。
- 新增测试 3 连跑全绿；`git diff --check` 通过；feature 三份 YAML 过 `validate-yaml.py`。

## 5. 多轮审计记录（代用户执行）

- **Round A（一致性取证）**：核对 `boundedString`（hardening-contract）与 `validateBoundedCommandInput` 的字符计数同源性，**发现并修复** validator 用 UTF-16 `.length` 而 schema 用 code point 的差异（surrogate pair 场景会出现 schema 放行、handler 拒绝），统一为 `Array.from().length`；核对 skip 分类优先级、output 扣减口径（completed 含失败命令的输出）、cache 模式兼容与空 batch 原行为——修复后无新问题。
- **Round B（稳定性与场景映射）**：新增 29 用例 3 连跑全绿；10 个验收场景逐条映射证据；确认 output 耗尽/deadline 的 handler 级不可实测边界并如实记录。

## 6. 边界与后续

- 单条 batch 命令仍固定 30s timeout：总 deadline 超期时在跑命令最多 overrun 30s 后结束，已完成命令如实保留——truthful 语义不变。
- 预算上限为编译期常量，未接入 `MCP_EXECUTION_PROFILE` 配置面；profile 化归属后续 backend/gate feature。
- 下游解锁：`kill-process-identity`、`bounded-command-execution` 已 done，主干剩 `search-and-adaptive-correctness` → `security-and-mcp-conformance-gates` → `docs-and-architecture-closeout`；`path-policy-no-follow` 与 `tool-wrapper-and-surface-contract` 仅依赖第 1 条，可随时开工。
