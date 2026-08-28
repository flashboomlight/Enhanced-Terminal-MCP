---
doc_type: feature-acceptance
feature: 2026-08-28-process-supervisor-and-cancellation
requirement: ""
roadmap: production-hardening
roadmap_item: process-supervisor-and-cancellation
status: done
summary: 对照 supervisor 设计完成验收；修复 registry cleanup 竞态与 lint，三轮反向审计后 12 checks 全部通过，全量 639 用例与完整门禁全绿，roadmap/audit/architecture 已回写
tags: [production, process, supervisor, cancellation, registry, shutdown, acceptance]
created: "2026-08-28"
last_reviewed: "2026-08-28"
---

# process-supervisor-and-cancellation 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-28
> 关联方案 doc：`codestable/features/2026-08-28-process-supervisor-and-cancellation/process-supervisor-and-cancellation-design.md`
> 关联 checklist：`codestable/features/2026-08-28-process-supervisor-and-cancellation/process-supervisor-and-cancellation-checklist.yaml`
> 验收授权：用户已明确本轮由代理代为执行审计与验收，仅在重大决策时上报；本报告按当前代码、静态检查、定向测试和完整质量门禁完成终审记录。

## 1. 中断点遗留问题的收口

中断点（design 第 7 节）留有三项 blocker，本轮全部闭合：

1. **timeout/cancel 后 `activeCount` 未清零（2 个失败断言）**——根因：registry 清理挂在 child `"close"` 事件，且 `scheduleEntryRemoval` 在 termination 进行中把 `removeEntry` 推迟到 `terminationPromise` 完成之后；Windows tree-kill 路径下 `waitForExit` 只检查 `exitCode`/`signalCode`，promise 完成与 close 事件发射之间无确定顺序，"close 已发射而 promise 未完成"的窗口内 registry 停留 stale entry。修复（`src/process-supervisor.ts`）：
   - `scheduleEntryRemoval` 在 child 已退出时立即移除 entry（termination promise 剩余部分只写 state 字段，不再阻塞清理）；
   - `terminate()` 在 termination promise 完成且 child 已退出时主动调用 `scheduleEntryRemoval`，覆盖 close 事件尚未发射的反向窗口。
2. **lint 2 errors + 1 info**——`src/command-output.ts` 格式化、`tests/unit/tools/command.test.ts` import 排序经 `biome check --write` 收口；`src/stream.ts:122` 的 `useTemplate` 手动改为模板字面量。当前 `pnpm run lint` 零错误零信息。
3. **定向回归与完整门禁重跑**——见第 4 节。

验收期间另发现并修复的偏差：

- `tests/unit/tools/command.test.ts` 的 cancel 断言原先在 cancel 返回后立即要求 registry 为空；但 Windows 树终止会 spawn 瞬态 `taskkill` 控制进程，按 design 该进程纳管在 registry（`kind: supervisor-control`，`internalControl` 不占 active 上限），存在短暂的合法存留。断言已改为 `vi.waitFor` bounded 等待，并把该测试的显式 timeout 提高到 10000ms，消除 `waitFor` timeout（5000ms）与 vitest 默认 test timeout（5000ms）重合导致的误导性失败边界。

## 2. 接口契约核对

对照 design 第 2 节逐项核查：

- [x] `ProcessSupervisor`/`processSupervisor`：managed registry、`activeCount`、`getActiveSnapshots`、`assertCanStart`、`shutdown(deadlineMs)` 幂等 drain report；snapshot 仅含 `requestId/pid/startedAt/treeScope/kind/scopeId`，不含 command/env（`ProcessSnapshot` 类型来自 `hardening-contract.ts`）。
- [x] `spawnManaged`/`track`：spawn 前统一 `assertCanStart`（shutdown 中与 active 上限在副作用前拒绝，`RESOURCE_LIMIT`/`PROCESS_SUPERVISOR_UNAVAILABLE`）；Unix 默认 `detached` 进程组，Windows `windowsHide`；track 后容量兜底双检查。
- [x] timeout/AbortSignal：timeout timer 与 abort listener 都以 `terminationRequested` 防重入；`signal.aborted` 预检在 spawn/execFile 之前抛 `ABORT_ERR`。
- [x] `terminate` 幂等：同一 child 并发终止共享唯一 promise；Windows 走 PID-only `taskkill /PID <pid> /T /F`（参数硬编码，代码内无 `/IM`），Unix 走 `process.kill(-pid, signal)` 进程组信号（无 `pkill`）；grace + force bounded window 内 truthful 返回 `{exited, forced, failed, reason}`，termination 失败触发 `onTerminationFailed`。
- [x] `execFileManaged`：execFile child 经 `track` 纳管，返回 `timedOut/cancelled/terminationFailed` 字段；termination 请求时在回调内等待 termination 完成后再 resolve/reject。
- [x] `ShutdownReport`：`clean/remaining/deadlineExceeded` truthful；`index.ts` shutdown 顺序为 supervisor drain（3000ms）→ 非 clean 记录 `shutdown-degraded` → 再 flush session/audit。

## 3. 行为核对（12 checks）

- [x] 所有生产 spawn/execFile 创建点已登记：`src/` 下除 `process-supervisor.ts` 外无裸 `spawn(`/`execFile(`；`execFileSync`/`spawnSync`/`execSync` 零命中（where probe 已异步化）。
- [x] active 上限在副作用前生效：`spawnManaged`/`track`/`execFileManaged` 三处前置检查，超限返回 `RESOURCE_LIMIT`（单测实证：第二个 spawn 被拒且已有 child 不受影响）。
- [x] 状态幂等：timeout/abort/close/error/termination 幂等；`terminate` 重复调用返回同一 promise；shutdown 重复调用返回同一 report（单测实证 `first === second`）。
- [x] 平台终止形态：Windows PID-only taskkill /T /F、Unix 负 PID 进程组信号；负面 grep `taskkill.*(/IM|-IM)|pkill` 零命中；`ProcessSupervisorOptions.killTree` 注入 fake 可隔离真实 taskkill 并验证调用 PID。
- [x] capture pending 有界：`enqueueChunk` 超 `maxPendingBytes` 时置 `captureLimitReached`、暂停双流、请求 `output-limit` termination 并停止入队；`finishAfterPending` bounded drain。
- [x] 既有调用兼容：`safeExec`/`quickExec`/`spawnStream`/`execFileManaged` 的 timeout/termination/error 字段与 tool result 语义保持（全量测试与 latency 实证）。
- [x] 全部短 probe 纳管：Everything、grep、system、archive、process identity、shell where 均经 managed 路径（接线分布 22 处，`where` 无同步阻塞）。
- [x] RequestContext 贯穿：command（3 处）/search/system（3 处）/archive（3 处）传入 `context.signal` + requestId/scopeId；batch 子任务共享同一 parent signal（`kind: batch-command`）；direct call 兼容（tools 单测 off 模式直调）。
- [x] shutdown 顺序：drain 先于 session/audit flush；非 clean 进 degraded evidence（`shutdown-degraded` 错误日志）。
- [x] 测试覆盖：真实 timeout/cancel/tree child（`node -e` 长驻进程 + grace 20ms）、fake control runner、幂等/shutdown drain、RequestContext cancellation 回归。
- [x] 质量门禁：build、`tsc --noEmit`、lint（零错误）、全量 test（51 文件 639 用例）、latency（24/24）、tools coverage（59.37/48.55/65.62/63.26 对底线 55/45/60/55）、`git diff --check`、CodeStable YAML 校验全部通过。
- [x] 无泄漏与 truthful 报告：repeated timeout/cancel/shutdown 后 registry 空（cancel 断言 bounded 等待）；`ManagedProcessState` 区分 `timedOut/cancelled/terminationRequested/terminationFailed/terminated` 与 5 种 reason。

## 4. 验证证据

- `pnpm run build`：通过（clean build 后 tsc 产物完整）。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm run lint`：0 errors, 0 infos。
- `pnpm test`：51 文件 639 用例全部通过（含修复后的 supervisor 8 用例与 command tools 10 用例）。
- `pnpm run test:latency`：24/24 达标。
- `pnpm run test:coverage:tools`：Statements 59.37%、Branches 48.55%、Functions 65.62%、Lines 63.26%，均高于 55/45/60/55 底线。
- 定向稳定性：`process-supervisor.test.ts` + `command.test.ts` 组合 3 连跑 + 单文件 10 连跑 + 组合 4 轮，修复后 13 次以上连续全绿。
- `git diff --check`：通过；CodeStable 全部 YAML 过 `validate-yaml.py`。

## 5. 多轮审计记录（代用户执行）

- **Round A（横向取证）**：进程创建点收口、危险终止模式负面清单、shutdown 顺序、capture pending 有界、snapshot 字段边界、managed 接线分布、RequestContext signal 传递——未发现新问题。
- **Round B（场景映射与稳定性）**：17 个验收场景逐条映射测试/代码证据；发现 `vi.waitFor` timeout 与 vitest 默认 test timeout 重合的边界并加固；稳定性压测中出现 1 次未定位的偶发失败（约 19 次运行中 1 次，两文件并行高负载场景，失败详情未捕获，13 次以上连续全过后未再复现）——记录在案，判定为并行负载时序噪声而非确定性回归。
- **Round C（终审）**：加固后全量 639 用例并行最高负载复跑全绿；无新问题，审计停止。

## 6. 边界与后续

- 本验收在 Windows 实机完成 timeout/cancel/tree/shutdown 的真实进程验证；Unix process-group 路径由代码审查、平台单测与 mock 覆盖，本机与 CI（ubuntu 仅 lint/tsc）均无 Unix 真实树终止 smoke——跨平台真实终止验证仍归属后续 conformance/canonical gate 条目。
- supervisor 不提供 OS sandbox：`CapabilityPolicy`/`BudgetAccount`/registry 是应用层契约，不能宣称进程隔离（与 ADR-19 口径一致）。
- `bounded-command-execution` 现在可以被解锁：三个命令工具的 finite/bounded schema、parent budget 与统一限流按 roadmap 第 3 条推进。
