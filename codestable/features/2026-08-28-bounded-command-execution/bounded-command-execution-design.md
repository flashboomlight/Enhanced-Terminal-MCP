---
doc_type: feature-design
feature: 2026-08-28-bounded-command-execution
roadmap: production-hardening
roadmap_item: bounded-command-execution
status: approved
summary: 三个命令工具接入 finite/bounded schema 与 batch parent BudgetAccount，形成 spawn 前拒绝、deadline 有界、预算证据 truthful 的最小命令闭环
tags: [production, hardening, command, schema, budget, batch, acceptance-gate]
created: "2026-08-28"
last_reviewed: "2026-08-28"
depends_on: [2026-08-28-hardening-contract-and-profiles, 2026-08-28-process-supervisor-and-cancellation]
---

# bounded-command-execution 设计

> 阶段：阶段 1（设计定稿）
> 创建日期：2026-08-28
> 状态依据：roadmap 第 3 条（minimal_loop）；用户已授权代理代为执行 CodeStable 全流程，design 由代理按 roadmap 既定范围审定并批准。
> 关联归档：DEC-001（hardBlock 不可关闭）、command-execution-not-sandbox、command-policy——本 feature 全部位于 policy 之后，不触碰安全核心。

## 0. 术语约定

- parent budget：`batch_execute` 入口创建的 `BudgetAccount("batch", limits, context.signal)`；`BudgetAccount.child()` 共享同一 ledger，子任务 reserve 直接扣减 parent 余额，不存在重置。
- budget skip：预算不可用或配额不足时，未调度命令以 `status: "skipped"` 记录并携带扩展的 `skip_reason`，envelope 不谎报 `all_ok`。
- schema 拒绝：zod 层拒绝（`finiteInt`/`boundedString`/`boundedArray`），非有限值（Infinity/NaN）、负数、超长输入在 handler 副作用前失败，走既有 MCP invalid-params 路径。

## 1. 决策与约束

### 需求摘要（来自 roadmap 第 3 条 + 审计 SEC-03/SEC-04/REL-02）

- 三个命令工具输入 schema 全部 finite/bounded：`timeout`/`duration` 拒绝 Infinity/NaN/非正数；`command` 拒绝超长字符/字节；`commands` 拒绝超大数组与超长单项。
- `batch_execute` 建立 parent BudgetAccount：input 聚合配额、output 聚合配额、batch 总 wall-time deadline；parallel 子任务共享 parent 预算且不可各自重置。
- 完成后 `execute_command` 在 local profile 下执行普通命令、正确取消超时、拒绝超大输入并返回 A+ envelope（最小闭环）。
- 既有调用兼容：普通命令行为不变，e2e/latency 全过。

### 明确不做

- 不修改 `DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、safeguard 三级模式或 command policy。
- 不给非命令工具加 schema（归属 `tool-wrapper-and-surface-contract`）。
- 不引入新环境变量：预算上限为启动常量；配置面归属后续 profile/backend feature。
- 不实现 descendant 进程计数（process tree 内后代计数归属后续 resource-stop 收尾；本 feature 只按命令粒度计预算）。
- 不改变 supervisor、capture、command-output 的输出捕获语义。

### 现状证据与根因

- `src/tools/command.ts:337` `timeout: z.number().optional()`、`:693` `duration: z.number().optional()`——`Infinity`/`NaN`/负数可通过 schema；`:480` `commands: z.array(z.string())` 无 `maxItems` 与单项上限。
- `hardening-contract.ts` 已提供 `finiteNumber/finiteInt/boundedString/boundedArray`、`BudgetAccount`（reserve/remaining/child/close、deadline timer + signal 联动）、`BudgetKind/Scope`——本轮是其首个真实消费者。
- batch worker pool（command.ts:640-652，并发 4）已有 `skip_reason: "stop_on_error"`（result.ts:370 `z.literal`）。

## 2. 设计方案

### 2.1 新模块 `src/command-budget.ts`

职责单一：batch 预算常量、parent account 构建与 skip 分类；不执行命令、不访问 shell。

- 常量（宽松有限，不改变正常用法）：
  - `MAX_COMMAND_CHARS = 65536`、`MAX_COMMAND_BYTES = 131072`（单条命令）
  - `MAX_COMMAND_TIMEOUT_MS = 3_600_000`（execute `timeout`；现默认 30s、adaptive 上限 120s）
  - `MAX_WATCH_DURATION_MS = 600_000`（watch `duration`；默认 5s、heavy 线 60s）
  - `MAX_BATCH_ITEMS = 100`、`MAX_BATCH_INPUT_BYTES = 2_097_152`（2MiB 聚合）
  - `MAX_BATCH_WALLTIME_MS = 600_000`（10min batch 总 deadline）
  - `MAX_BATCH_OUTPUT_BYTES = 104_857_600`（100MiB 聚合输出配额）
- `buildBatchBudget(signal?: AbortSignal, overrides?: Partial<BudgetLimits>): BudgetAccount`——`scope: "batch"`、`deadlineAt = Date.now() + walltime`、max vector `{ input: MAX_BATCH_INPUT_BYTES, output: MAX_BATCH_OUTPUT_BYTES, 其余 0 }`；signal 链接 `context.signal`，overrides 仅供测试注入小预算。
- `commandBudgetSkipReason(account): "budget_deadline" | null`——account 不可用时：`Date.now() >= account.deadlineAt` 且 abort 由 deadline 触发 → `budget_deadline`；外部 cancel 已由 CANCELLED 路径处理，不在此重复分类。

### 2.2 三个命令工具 schema 收紧（`src/tools/command.ts`）

- `execute_command`：`command: boundedString(MAX_COMMAND_CHARS, MAX_COMMAND_BYTES).optional()`；`timeout: finiteInt(1, MAX_COMMAND_TIMEOUT_MS).optional()`。
- `batch_execute`：`commands: boundedArray(boundedString(MAX_COMMAND_CHARS, MAX_COMMAND_BYTES), MAX_BATCH_ITEMS)`。
- `watch_command`：`command: boundedString(MAX_COMMAND_CHARS, MAX_COMMAND_BYTES)`；`duration: finiteInt(1, MAX_WATCH_DURATION_MS).optional()`。
- **实现补充（验收期间）**：schema 由 SDK 层消费，直调 handler 的调用方不经过 zod；按 kill-process-identity 先例，三个 handler 在副作用前用 `validateBoundedCommandInput`（command-budget.ts）以同一组常量二次校验，失败返回 `VALIDATION_ERROR`。字符计数与 `boundedString` 同源（Unicode code point），bytes 用 `Buffer.byteLength`。

### 2.3 batch parent 预算接线（`src/tools/command.ts` batch handler）

1. handler 入口构建 `budget = buildBatchBudget(context.signal)`。
2. spawn 前聚合预检：`Buffer.byteLength` 之和若超 `remaining("input")` → 整批 `RESOURCE_LIMIT`（retryable，detail 携带 `limit/exceeded`），不执行任何命令。
3. worker 调度前检查 `budget.abortSignal.aborted` → 未调度命令 `skipped`；deadline 触发 → `skip_reason: "budget_deadline"`；`stop_on_error` 保持原语义且优先级不变。
4. 每条命令执行前 `reserve("input", bytes)` 失败 → 该命令 `skipped`（`budget_input`，单条字节超剩余）；完成后 `reserve("output", actualBytes)` 失败 → 置 `stopScheduling`（output 配额耗尽），剩余命令 `skipped`（`budget_output`），已完成命令如实保留。
5. finally 中 `budget.close()`；deadline timer 已 unref，不阻塞进程退出。

### 2.4 错误与 envelope 语义

- schema 层拒绝走 zod invalid-params（与现有 `pageSize` 上限一致），错误码不新增。
- 预算拒绝统一 `RESOURCE_LIMIT`（result.ts 既有码，retryable）。
- `BatchCommandResult.skip_reason` 从 `z.literal("stop_on_error")` 扩展为 `z.enum(["stop_on_error", "budget_deadline", "budget_input", "budget_output"])`（result.ts 类型联合与 schema 同步）；`skipped` 语义不变：未执行、无副作用。
- envelope 结构不变（results/all_ok/completed/failed/skipped/summary）；预算证据通过 `skip_reason` 传递，不新增顶层字段。

## 3. 挂载点

| 文件 | 变更 |
|------|------|
| `src/command-budget.ts`（新增） | 常量、`buildBatchBudget`、`commandBudgetSkipReason` |
| `src/tools/command.ts` | 三 schema 收紧；batch handler 预算接线（预检/worker 检查/reserve/close） |
| `src/result.ts` | `skip_reason` 类型与 schema 扩展 |
| `tests/unit/command-budget.test.ts`（新增） | 预算单元：构建、reserve、共享 ledger、deadline/skip 分类、overrides |
| `tests/unit/tools/command.test.ts` | schema 拒绝（Infinity/NaN/超长/超大 batch/byte 超限）、聚合预检 RESOURCE_LIMIT、预算 skip 场景 |

## 4. 实现维度

- 维度档位：B（中等）——单一职责新模块 + 两文件接线；不改安全核心、不改执行链。
- 函数超一屏检查：batch handler 现已超长，但本次只在 3 个明确插入点增加 ≤30 行；预算逻辑全部在新模块，command.ts 净增可控。
- 测试维度：单元（command-budget 纯逻辑）+ 工具层（直调 handler：schema 拒绝、聚合预检、output 配额 skip）+ 全量回归（e2e/latency/coverage 门禁）。
- wall-time 真实触发不在 handler 级测试（10min 常量），由单元测试证明 deadline abort → `budget_deadline` 分类正确；worker 检查点为单一 if，代码审查覆盖。

## 5. 验收场景

1. `execute_command` 传入 `timeout: Infinity`/`NaN`/`0`/`-1` 在副作用前被 schema 拒绝。
2. `watch_command` 传入 `duration: Infinity`/`NaN`/`0` 被拒绝；`command` 超长被拒绝。
3. `execute_command`/`watch_command` 传入超过 `MAX_COMMAND_CHARS` 的 command 或 UTF-8 多字节导致 byte 超限被拒绝。
4. `batch_execute` 传入超过 `MAX_BATCH_ITEMS` 条或单项超长被拒绝。
5. batch input 聚合超限：schema 内合法但总和超 2MiB → `RESOURCE_LIMIT`，零命令执行。
6. batch output 配额耗尽：多命令输出超出聚合配额 → 已完成命令如实保留，剩余 `budget_output` skipped，`all_ok=false`，`skipped>0`。
7. batch deadline 到点：worker 不再调度，剩余 `budget_deadline` skipped（单元级验证分类与 abort 联动）。
8. parallel 子任务共享 parent ledger：并发下 reserve 扣减同一份余额，不出现各自重置（单元级 child() 语义 + 并发 reserve 测试）。
9. 普通命令兼容：echo/短 batch/watch 短时长行为与 envelope 不变；全量 e2e、latency 24/24、tools coverage 达标。
10. `git diff --check`、CodeStable YAML 校验通过；不触碰安全核心文件。

## 6. 反向检查与明确拒绝

- 不接受以增大 schema 上限掩盖预算缺口，也不接受把上限压到破坏现有合法用法（e2e/latency 为准）。
- 不接受预算 skip 被计入 `completed` 或 `all_ok=true`。
- 不接受在 budget 路径写命令原文到 snapshot/audit（复用既有 audit 语义）。
- 不接受绕过 `wrapHandler`/`commandSafetyGate` 的旁路执行。
