---
doc_type: feature-design
feature: 2026-08-28-process-supervisor-and-cancellation
requirement: ""
roadmap: production-hardening
roadmap_item: process-supervisor-and-cancellation
status: approved
summary: 建立统一 child process registry、timeout、AbortSignal、Unix process group、Windows tree termination、pending capture queue 上限和 shutdown drain，覆盖所有生产 spawn/execFile 入口
tags: [production, process, supervisor, cancellation, timeout, shutdown, windows, unix]
created: "2026-08-28"
last_reviewed: "2026-08-28"
---

# process-supervisor-and-cancellation 设计

> 本 feature 从 production-hardening roadmap 第 2 条起头。用户已明确把提交决策、审核和继续推进交给代理，因此本稿基于共享 RequestContext、BudgetAccount、ExecutionHandle 和 ShutdownReport 契约直接标记为 approved。
>
> 本 feature 只负责 child process 生命周期和取消边界，不决定命令是否允许，不替代 OS sandbox，也不提前完成所有工具的输入/输出预算、路径 no-follow、秘密治理、SSRF/archive 或 MCP conformance。

## 0. 术语约定

| 术语 | 定义 | 防冲突结论 |
|---|---|---|
| managed process | 由 ProcessSupervisor registry 登记、带 kind/request scope、超时、取消、树范围和生命周期清理的 ChildProcess | 任何生产 spawn/execFile 必须登记；短 probe 也必须是有界 control kind |
| process snapshot | requestId、pid、startedAt、treeScope 及内部 kind 的不可变观察记录 | 不保存原始 command、env 或 secret；snapshot 不是认证凭据 |
| tree scope | Windows 的 PID tree 或 Unix 的 detached process group | scope 只能来自 supervisor 创建/登记的 child，不接受用户传入 PID 作为范围 |
| termination reason | timeout、cancelled、output-limit、shutdown、internal-error | 同一进程只允许一个幂等 termination promise，不能重复竞争 SIGTERM/SIGKILL/taskkill |
| control process | supervisor 为 Windows tree termination 启动的固定 taskkill 命令 | 参数只来自已登记 PID；有独立短 timeout，异常不会阻塞 shutdown |
| pending capture budget | capture 尚未完成的 onChunk promise 所占字节总量 | 由 enqueue 时实际 chunk byte 计算，超限先暂停流并请求树终止 |
| shutdown drain | 停止接受新的 managed process，终止现存 registry，等待 close/error 到 deadline 并返回 ShutdownReport | deadline 超过必须报告 remaining/deadlineExceeded，不能静默 process.exit(0) |

## 1. 决策与约束

### 需求摘要

**做什么**：把当前分散在 capture、stream、safeExecFile、shell probe、Everything、grep、system、archive 和 process identity 中的 child process 生命周期统一纳管，保证 timeout、MCP AbortSignal、输出/队列超限和 server shutdown 都能终止正确的 process tree，并能报告残留。

**为谁**：MCP tool handler、内部平台 probe、维护者和需要在请求断开/进程退出时确认没有遗留子进程的 host。

**成功标准**：

1. 所有生产 spawn/execFile 创建点都可在 registry 中看到 requestId、pid、startedAt、kind 和 treeScope；自然 close/error 后从 registry 幂等移除。
2. 每个 managed process 只有一个 timeout/abort/termination 状态；timeout 和 AbortSignal 在有界时间内终止 child，不能只 kill shell 父进程而留下后代。
3. Unix child 使用 detached process group，终止时按负 PID 发送信号；Windows tree 使用固定 taskkill /PID /T /F 兜底，绝不把用户输入拼入命令。
4. capture 的 pending onChunk queue 按实际 bytes 有上限，超过上限暂停读取、设置 captureLimitReached 并请求树终止；终止后仍在 bounded drain deadline 内收集结果。
5. shell where/probe、Everything、grep、system、archive、process identity 的短命令也经过 supervisor；内部 probe 不接收用户未校验的 shell string，失败有界返回。
6. shutdown 先停止新 process，再执行 tree termination，等待 registry 清空或 deadline，之后才 flush session/audit；残留以结构化 ShutdownReport 和 degraded 日志暴露。
7. 现有 timeout、output、error、tool 数量、命令策略和 kill identity 兼容行为不因 supervisor 接入而破坏；新增 cancellation 只在 signal 真正 aborted 时生效。

### 明确不做

- 不实现完整 OS sandbox、Job Object native addon、容器、seccomp、受限 token 或远程 transport。
- 不改 DANGEROUS_PATTERNS、HARD_BLOCK_PATTERNS、hardBlock、command policy、SafeGuard 或 kill_process 的 identity decision。
- 不在本 feature 内完成所有 MCP input finite/bounded schema 和 BudgetAccount 全量扣减；只提供 active process、termination 和 pending capture seam，剩余工作由 bounded-command-execution 继续接入。
- 不把 taskkill、where、ps、Everything、grep 或 PowerShell probe 的业务错误改写成搜索/系统/归档语义之外的新错误码；handler 仍负责业务映射。
- 不保证对已经由用户 shell 自己 daemonize、脱离 process group 或 Windows job/tree 之外的进程拥有形式化控制；报告必须将无法证明的残留标记为不 clean。
- 不通过全局 process.kill、pkill、taskkill /IM 或用户传入 PID tree scope 扩大终止范围。

### 现状证据与根因

截至 2026-08-28：

- capture.ts 和 stream.ts 各自实现 SIGTERM/SIGKILL timer；两套逻辑的 grace、失败和树终止语义不一致，spawn 默认没有 Unix detached group。
- utils.ts safeExecFile 直接 execFile 并依赖 Node maxBuffer/timeout；search.ts 的 Everything/grep 也直接 execFile，未接入 active registry 或 MCP signal。
- shell.ts defaultWhich 使用同步 execFileSync where，阻塞 event loop，无法被 AbortSignal 或 shutdown drain 观察；shell version probe 通过 spawnStream，但没有 request scope。
- system/archive/process-identity 通过 safeExecFile 创建系统、归档和 identity probe；没有统一 kind、requestId、树范围或 active count。
- index.ts shutdown 只 fire-and-forget session/audit flush、destroy pool 和固定 3 秒 process.exit(0)，没有等待 active child，也没有返回 drain status。
- capture 的 pending Set 没有 pending bytes/chunk 上限；限制 retained output 不能阻止高频异步 onChunk 造成内存增长。

## 2. 设计方案

### 2.1 ProcessSupervisor 核心

新增 src/process-supervisor.ts，提供 ProcessSupervisor 类和默认 singleton processSupervisor：

1. spawnManaged(file,args,options) 在 spawn 前检查 maxActiveProcesses，Unix 默认 detached=true，立即登记 ManagedProcess。
2. track(child,options) 供 execFile child 登记；登记 snapshot 包含 requestId、pid、startedAt、kind、treeScope，无法取得合法 PID 时 fail-closed 或标记为 control-only。
3. 每个登记项拥有 timeout timer、AbortSignal listener、terminationPromise 和 LifecycleState；close/error/unregister 清理 timer、listener 和 registry。
4. terminate(child,reason) 幂等执行。Unix tree scope 先对负 PID 发 SIGTERM，grace 后对负 PID 发 SIGKILL；非 tree 只作用于 child。Windows tree 使用固定 taskkill /PID pid /T /F，非 tree 使用 child.kill，控制命令自身有 2 秒上限。
5. getActiveSnapshots() 返回排序稳定的 snapshot；activeCount 和 maxActiveProcesses 供 health/后续 budget 使用。
6. shutdown(deadlineMs) 设置 shuttingDown，拒绝新的 managed spawn，终止快照中的所有 child，轮询 registry 至空或 deadline，返回 clean、remaining、deadlineExceeded；重复调用复用同一 promise。

默认运行参数：

| 参数 | 默认值 | 约束 |
|---|---:|---|
| maxActiveProcesses | 64 | 1 到 1024，支持构造注入测试 |
| graceful termination wait | 500ms | 0 到 5000，超时后强制树终止 |
| force termination wait | 1500ms | 100 到 10000，超时标记 terminationFailed |
| control command timeout | 2000ms | 固定内部上限，不读用户配置 |
| maxPendingCaptureBytes | 4 MiB | capture opts 可注入，后续由 ExecutionLimits 接管 |
| shutdown deadline | 3000ms | index 先等待 supervisor，再 flush state/audit |

### 2.2 capture/stream 接入

- captureCommand 改用 spawnManaged，timeout 由 supervisor 定时器触发，AbortSignal 由 supervisor 触发，回调只设置 timedOut/cancelled/terminationFailed 状态。
- capture 的每流 pendingBytes 在入队前增加、完成后减少；超过 maxPendingCaptureBytes 时暂停 stdout/stderr、设置 captureLimitReached、请求 output-limit termination，不再接受新的 pending task。
- capture 继续等待 close 后的 pending tasks，但新增 drain deadline；超过 deadline 返回 terminationFailed，不能无限等待。
- spawnStream 删除自有 SIGTERM/SIGKILL timer，改用 spawnManaged；timeout、cancel、maxOutput termination 共用 supervisor；保留 StreamResult 字段并增加 cancelled/terminationFailed 的明确状态。
- Unix managed child 默认 detached，Windows 默认 windowsHide；用户提供的 cwd/env/args 不改变 tree scope。

### 2.3 execFile 和短 probe 接入

新增 execFileManaged(file,args,options)：

1. 在 execFile 前检查 active capacity，使用 execFile 的固定 maxBuffer/encoding/cwd/env，关闭 Node 内置 timeout，统一交给 supervisor。
2. 将 child 立即 track，timeout/AbortSignal/tree termination 由 supervisor 处理；callback error 包装为带 stdout/stderr/timedOut/cancelled/terminationFailed 的 ManagedProcessError。
3. safeExecFile 保留现有四参数兼容形式，同时接受 options object；内部只消费 execFileManaged。
4. search Everything、grep、system、archive 和 process identity 改用 execFileManaged 或 safeExecFile options，kind 分别标记 everything-search、grep、system、archive、identity。
5. shell defaultWhich 改为异步 spawnStream where probe；ResolveShellOptions.which 兼容同步注入测试函数并在 resolveShell 内 await，取消同步 execFileSync。

### 2.4 RequestContext 和错误映射

- execute_command、batch_execute、watch_command、search、system 和 archive handler 接收 wrapHandler 传入的 RequestContext，向 managed execution 传 context.signal、requestId、scopeId。
- runCommandOutput/CommandOutputRun/CaptureResult/StreamResult 增加 cancelled 状态；commandError 将 cancelled 映射为 CANCELLED，timeout 仍映射 TIMEOUT，terminationFailed 仍映射 EXECUTION_FAILED 或明确 tree failure。
- safeExecFile 的 ManagedProcessError.cancelled 由 system/archive/search handler 映射为 Errors.cancelled；内部 identity/shell probe 沿用已有 fail-closed 错误。
- 直接调用没有 MCP extra 时使用 direct-call requestId 和永不 aborted 的 signal，保持现有单测/内部 API 兼容。

### 2.5 shutdown lifecycle

index.ts 的 shutdown 改为幂等 async drain：

1. 第一次 SIGTERM/SIGINT 设置 shuttingDown，停止 processPool 新任务和 temp cleanup。
2. 调用 processSupervisor.shutdown(3000)，记录 clean/remaining/deadlineExceeded；不 clean 时记录 degraded 并设置非零 exitCode。
3. 等 supervisor 返回后执行 session.flush 和 audit.flush，二者失败记录 warn，最后按 drain 状态退出。
4. 多次信号不重复启动 flush/exit；main 启动失败仍走统一 fatal 日志和确定退出码。

## 3. 挂载点

1. 核心模块：src/process-supervisor.ts、src/hardening-contract.ts 的 ProcessSnapshot/ShutdownReport。
2. 执行器：src/capture.ts、src/stream.ts、src/utils.ts、src/command-output.ts。
3. shell/probe：src/shell.ts、src/process-identity.ts、src/tools/search.ts。
4. tool handlers：src/tools/command.ts、src/tools/system.ts、src/tools/archive.ts。
5. lifecycle：src/index.ts。
6. 测试：tests/unit/process-supervisor.test.ts、capture/stream/utils/command/search/system/archive 回归测试和跨平台 process tree smoke。

## 4. 实现维度

- 健壮性：L3。所有 child lifecycle、timeout、abort、termination failure 和 shutdown residual 都有明确状态。
- 结构：modules。registry/termination、capture、stream、execFile adapter 和 lifecycle 分离。
- 性能：budgeted。active process、pending bytes、grace、force wait、shutdown deadline 均有上限。
- 可读性：team/public。snapshot、kind、reason 和报告字段可被维护者/host 直接理解。
- 可演进性：stable。保留现有函数参数兼容，后续 BudgetAccount 可替换当前 active/pending seam。
- 可观测性：logged。registry drain 和 termination failure 记录稳定事件，不写 command/env 原文。
- 可测试性：verified。fake control runner、real child timeout/cancel、Unix/Windows tree smoke 和全量 gate。
- 安全性：hardened。树终止只能以登记 child PID/group 为边界，固定 taskkill 参数，不接受 name/wildcard。
- 兼容性：backward-compatible。保留现有 stream/capture/safeExecFile 调用方式、error code 和 tool surface。
- 并发：thread-safe in event loop。termination、unregister、shutdown 使用幂等 promise，避免重复 kill。
- 确定性：deterministic。registry snapshot 排序、reason/state 转换和 shutdown report 稳定。

## 5. 验收场景

1. 任意 spawnManaged child 立即进入 registry，close/error 后移除，snapshot 不包含原始 command/env。
2. active process 达到上限时新 spawn 在副作用前拒绝，已有 child 不被误终止。
3. timeout child 在 grace + force 窗口内结束，timeout 状态准确，registry 最终为空。
4. AbortSignal 在 child 运行中 abort，树终止且返回 cancelled，不误报 natural success。
5. signal 已 aborted 时不启动新 child。
6. Unix detached child 的 process group 可被负 PID 信号终止；Windows tree 使用 PID-only taskkill /T /F，不生成 /IM。
7. output-limit/termination failure 只调用一次 termination，重复 cancel/shutdown 不竞争 kill。
8. capture pending chunks 达到 maxPendingCaptureBytes 时停止接收新 task、设置 captureLimitReached 并在 bounded drain 后返回。
9. safeExecFile、Everything、grep、system、archive、process identity 和 shell probe 都能在 registry 中观察并在 timeout/close 后移除。
10. shell where probe 不再使用同步 execFileSync，event loop 不被阻塞，缺失命令按既有 fallback。
11. command/search/system/archive 传入 RequestContext.signal 后能够取消正在运行的 child，直接调用兼容。
12. batch 子任务共享同一个 parent signal，某个 child cancel 不会产生无法回收的 sibling。
13. server shutdown 先 drain supervisor 再 flush session/audit；残留/超时返回 degraded evidence，不直接报告 clean。
14. fake control runner 可验证 Windows taskkill 参数只包含固定 /PID pid /T /F，不触发真实 taskkill。
15. error mapping 保持 TIMEOUT、CANCELLED、EXECUTION_FAILED、PROCESS_TREE_TERMINATION_FAILED 语义，MCP ToolResult/isError 不破坏。
16. repeated timeout/cancel/shutdown 后无 active registry、timer、AbortSignal listener 或 pending capture 泄漏。
17. build、tsc、lint、全量 test、latency、主 coverage、tools coverage、git diff --check 和 CodeStable 校验通过。

## 6. 反向检查与明确拒绝

- 不接受只在 capture.ts 增加 kill，而遗漏 stream、safeExecFile、search、system、archive、identity 和 shell probe。
- 不接受 Windows 用 taskkill /IM、Unix 用 pkill 或以用户输入决定 tree scope。
- 不接受 timeout/abort 只终止父 shell，或终止失败后仍返回 clean/killed/success。
- 不接受通过增大 queue、maxBuffer 或 timeout 默认值掩盖没有 pending/active budget 的问题。
- 不接受 shutdown 使用固定 process.exit(0) 绕过 supervisor drain。
- 不接受把 command、env、secret 写入 ProcessSnapshot、termination log 或 health 输出。
- 不接受把 direct-call compatibility 当作 MCP request cancellation 已接入；只有真实 RequestContext.signal 才能代表 host cancel。

## 7. 当前已回写的实施进度（2026-08-28 中断点）

本节只记录当前工作树中已经实施的部分，不替代阶段 3 acceptance，也不改变本 design 的 `approved` 状态。

### 已完成的实现节点

- 已完成全部 child process inventory 和本 feature design/checklist；来源、挂载点、termination 边界和 17 个验收场景均已落盘。
- 已新增 `src/process-supervisor.ts`，包含 `ProcessSupervisor`、`processSupervisor` singleton、managed process snapshot/state、active process 上限、timeout/AbortSignal 状态、幂等 termination、Unix process-group / Windows PID-tree termination 适配和 bounded shutdown report。
- 已将 `capture.ts`、`stream.ts` 的生产 spawn 接入 supervisor，并加入取消状态、termination failure 状态、capture pending bytes 上限和 termination 后的 bounded 等待路径。
- 已将 `safeExecFile` 改为通过 `execFileManaged` 纳管；Everything、grep、system、archive、process identity 和 shell `where` probe 已接入相应的 managed execution / RequestContext 传递路径，`where` 不再使用同步 `execFileSync`。
- 已把 `RequestContext` 的 `signal`、`requestId`、`scopeId` 传入 command/search/system/archive 的相关执行入口，并补充 `cancelled` 的命令输出、错误映射和结果字段。
- 已调整 `src/index.ts` shutdown 顺序为先请求 supervisor drain，再 flush session/audit；该顺序已经写入工作树，但尚未通过本 feature 的完整 shutdown acceptance。
- 已新增 `tests/unit/process-supervisor.test.ts` 和 command context cancellation 回归测试，并更新相关 mock/兼容调用。

### 当前验证证据与未完成项

- `pnpm exec tsc --noEmit`：通过。
- 定向验证涉及 11 个测试文件、113 个测试：111 个通过，2 个失败；失败均位于 `tests/unit/process-supervisor.test.ts` 的 timeout/cancel 场景，`managed.state` 已标记终止，但测试观察到 `activeCount` 仍为 1，说明 registry 清理时序尚未闭合。
- `pnpm run lint`：未通过，当前输出包含 2 个 error 和 1 个 info，涉及本次 supervisor 接入的 `src/stream.ts`、`src/command-output.ts` 以及 command 测试 import 顺序；因此不能把本轮验证称为质量门禁通过。
- `build`、全量 `test`、latency、主 coverage、tools coverage、跨平台 tree smoke、shutdown residual 和 CodeStable acceptance 级检查尚未因本次中断而重新完成。
- 当前 checklist 的 12 个 checks 仍保持 `pending`，本 feature 没有创建 acceptance 报告；roadmap item 仍保持 `in-progress`。

### 当前边界结论

当前可以确认“统一 supervisor 及其调用接线已经开始落地”，不能确认“所有生产 child lifecycle 已无残留并达到生产验收标准”。恢复执行时，必须先修复 timeout/cancel 后 registry 清理的失败断言和 lint，再重新跑定向回归、shutdown/tree/pending queue 场景及完整质量门禁，之后才允许更新 checklist checks 或创建 acceptance 报告。
