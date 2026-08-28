---
doc_type: feature-acceptance
feature: 2026-08-28-hardening-contract-and-profiles
roadmap: production-hardening
roadmap_item: hardening-contract-and-profiles
status: done
summary: 对照设计完成共享生产硬化契约验收；修复 wrapHandler 上下文未接入和 profile 可切换偏差，补齐过期预算同步取消，并完成门禁、启动 fail-closed 和 CodeStable 回写
tags: [production, hardening, contract, profile, budget, capability, acceptance]
created: "2026-08-28"
last_reviewed: "2026-08-28"
---

# hardening-contract-and-profiles 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-28
> 关联方案 doc：`codestable/features/2026-08-28-hardening-contract-and-profiles/hardening-contract-and-profiles-design.md`
> 关联 checklist：`codestable/features/2026-08-28-hardening-contract-and-profiles/hardening-contract-and-profiles-checklist.yaml`
> 验收授权：用户已明确要求由本代理代为执行审核并继续推进；本报告按当前代码、测试和运行时证据完成终审记录。

## 1. 接口契约核对

对照 design 第 2.1 节名词层和第 2.2 节编排层逐项核查。

**接口示例逐项核对**：

- [x] `RequestContext`：`src/hardening-contract.ts:31-45` 定义 `requestId`、`scopeId`、固定 `profile`、`AbortSignal`、可选 `sessionId/authInfo`；`src/profile.ts:115-131` 只从 runtime `extra` 取值，不从 tool arguments 取可信上下文。
- [x] `ExecutionProfile`：`src/hardening-contract.ts:8` 只接受 `local-trusted-shell` / `sandboxed-production`；`src/profile.ts:61-72` 对未知、空白和大小写变体返回 `CONFIG_INVALID`。
- [x] `CapabilityPolicy`：`src/hardening-contract.ts:47-55` 提供稳定 policy 契约；`src/profile.ts:133-151` 保留 local 兼容能力，sandbox 只放行宿主显式声明的能力。
- [x] `InputBudget` / `ExecutionLimits` / `BudgetAccount`：`src/hardening-contract.ts:57-104,234-370` 已提供字段契约、父子共享账本、deadline、AbortSignal 和幂等 close。
- [x] strict schema/config helper：`src/hardening-contract.ts:373-429` 提供 `finiteNumber`、`finiteInt`、`boundedString`、`boundedArray` 和 `parseStrictInteger`；`src/utils.ts:11-21` 将历史 `envInt` 接入严格解析。
- [x] structured error compatibility：`src/result.ts:16-49,173-313` 保留已有错误码字符串并新增生产硬化错误工厂，既有 `ToolResult` / `toCallToolResult` / `isError` 转换未改语义。

**名词层“现状 → 变化”逐项核对**：

- [x] 原先没有项目级 request context → `wrapHandler` 现在接收 `(args, extra?)`，调用 `createRequestContext`，旧的单参数 handler 仍可直接使用。
- [x] 原先没有固定执行 profile → `main()` 在创建 server 和连接 transport 前调用 `initializeExecutionProfile()`。
- [x] 原先各处可自行使用前缀数字配置 → `envInt` 不再接受 `100evil`、科学计数法或不安全整数。
- [x] 原先没有共享父子资源账本 → `BudgetAccount.child()` 共享同一内部 state，不复制独立额度，子账本不能重置 parent。

**验收期间发现并已修复的设计/实现偏差**：

- 初次核对发现 `wrapHandler` 虽有 context 转换函数，但实际 handler 签名和返回 callback 没有消费 MCP `extra`；已在 `src/wrap.ts:34-79` 接入，并在 `tests/unit/wrap.test.ts` 增加 runtime context 回归测试。
- 初次核对发现 `initializeExecutionProfile` 在重复调用时可以覆盖进程级 profile；已改为 profile 初始化后禁止切换，切换尝试返回 `CONFIG_INVALID`，并补充回归测试。
- 细审发现设计图曾暗示 wrapper 自动创建 request budget，但本 feature 没有全局默认额度来源；已回填 design 第 2.2 节，明确由后续执行 feature 按工具/profile limits 创建 request-scope `BudgetAccount`，本 feature 只提供共享账本契约，避免引入无依据的默认上限。

## 2. 行为与决策核对

**需求摘要逐项验证**：

- [x] 共享契约独立成模块：新增 `src/hardening-contract.ts` 和 `src/profile.ts`，没有把预算、profile 和 capability 堆入万能 util。
- [x] 默认 profile 保持兼容：未设置 `MCP_EXECUTION_PROFILE` 解析为 `local-trusted-shell`；默认 profile 的 server 全量测试和 e2e 门禁通过。
- [x] profile fail-closed：非法 profile 在创建 `McpServer` 前失败；当前 sandbox backend 未提供时显式返回 `SANDBOX_UNAVAILABLE`，不降级为 local。
- [x] 输入和配置边界确定：非有限数、小数、负数、超范围、超字符/byte/数量和非完整十进制配置值均按契约拒绝。
- [x] parent/child 预算边界确定：reserve 为同步操作；child 共享 parent state；parent abort 会传播到 child；关闭和过期不会产生负账本。
- [x] capability 最小权限确定：local 保持既有本机能力；sandbox 默认拒绝主机 shell、主机进程查看、环境读取和网络出口，宿主声明后仅放行对应能力。
- [x] 兼容性只增不改：既有 20 个错误码的字符串不变，新增 11 个 roadmap 错误码及构造函数；没有改动 `MCP_SAFETY_MODE`、`MCP_COMMAND_POLICY`、`MCP_COMMAND_CONFIRMATION` 或 hardBlock。

**明确不做逐项核对**：

- [x] 未实现 Job Object、pidfd、process group、PID identity 或 process tree kill；这些属于 `process-supervisor-and-cancellation` / `kill-process-identity`。
- [x] 未实现所有工具 schema 的批量接入、文件 no-follow、秘密扫描、SSRF、HTTP client、archive budget 或完整执行 budget；这些由 roadmap 对应 feature 负责。
- [x] 未新增 MCP tool、resource、prompt、transport，也未新增运行时第三方依赖。
- [x] 未把 `CapabilityPolicy` / `BudgetAccount` 误描述成 OS sandbox；架构和 acceptance 均明确当前 sandbox backend 仍不可用。

**关键决策落地**：

- [x] D1：共享契约单独模块 → `src/hardening-contract.ts` 承载类型/校验/账本，`src/profile.ts` 承载 profile/capability。
- [x] D2：profile 启动时固定 → `src/index.ts:47` 启动 gate，`src/profile.ts:87-106` 防止重复初始化切换。
- [x] D3：capability 默认最小权限 → `LOCAL_TRUSTED_CAPABILITIES` 和 sandbox declared set 分离，未声明能力稳定返回 `CAPABILITY_DENIED`。
- [x] D4：共享 parent ledger → `BudgetAccount.fromState` 为 child 建立 view，所有 reserve 直接更新同一 state。
- [x] D5：strict validation 与兼容适配分离 → schema helper 独立于 `envInt`，不修改历史调用方接口。
- [x] D6：错误码只增不改 → `ErrorCode` 旧值保持，新增错误只扩展协议表和 factory。
- [x] D7：不提前实现后续行为 → 本次生产代码 diff 没有 process/path/network/secret/archive 业务行为改造。

**编排层和跨层纪律**：

- [x] profile gate 位于 server 创建和 `server.connect()` 之前；`src/index.ts:47` 与 `src/index.ts:83` 的顺序证据已核对。
- [x] context 信任边界位于 wrapper；`tests/unit/wrap.test.ts` 用 arguments 中的伪造 `profile` 对照 runtime `extra` 验证未被覆盖。
- [x] 过期账本在构造时同步 abort；`src/hardening-contract.ts` 在 `deadlineAt <= Date.now()` 时不再等待下一轮 timer。
- [x] 错误和可观测字段不加入 command/path/URL/env 原文；本 feature 的错误工厂只接收有限摘要/参数字段，后续 ResultBoundary 仍由对应 roadmap feature 完成。

**挂载点反向核对（可卸载性）**：

- [x] M1 `MCP_EXECUTION_PROFILE`：`src/profile.ts:61` 读取，`src/index.ts:47` 启动挂载，未知值/不可用 backend 在 transport 连接前失败。
- [x] M2 server startup profile gate：没有在工具注册或 transport 连接之后才做 profile 校验。
- [x] M3 shared contract exports：`src/hardening-contract.ts` / `src/profile.ts` 提供后续 feature 的类型、helper、budget 和 policy 入口。
- [x] M4 error compatibility surface：`src/result.ts` 只做 additive 错误码和 factory 扩展。
- [x] M5 `wrapHandler` runtime context adapter：`src/wrap.ts:34-79` 是唯一 wrapper 挂载点，保留原有 telemetry/cache 流程。
- [x] M6 `envInt` compatibility adapter：`src/utils.ts:11-21` 是历史环境变量入口的唯一 strict parser 接入点。
- [x] 反向 grep：feature 新模块只在上述 startup、wrapper、utils、result、测试和文档位置被引用；`src/hardening-contract.ts` / `src/profile.ts` 中没有 `registerTool`、`server.resource` 或 `server.prompt`。
- [x] 拔除沙盘推演：移除新增模块及其 import 时，唯一需要同步移除的是 M1–M6 的明确引用；没有发现隐式注册、隐藏 transport 或未列出的业务工具挂载点。

## 3. 验收场景核对

对照 design 第 3 节 15 条关键场景逐条验证。测试证据以当前构建和当前工作树为准。

- [x] **S1** 未设置 `MCP_EXECUTION_PROFILE` → `readExecutionProfile({})` 返回 `local-trusted-shell`；默认环境下完整 server/e2e 门禁通过。
  - 证据来源：`tests/unit/hardening-contract.test.ts`、`pnpm run gate`
  - 结果：通过。
- [x] **S2** 两个合法 profile → 两个枚举值可解析；大小写变体被拒绝。
  - 证据来源：profile parser 单测
  - 结果：通过。
- [x] **S3** 空白、未知或超长 profile → `CONFIG_INVALID`；实际 `invalid-profile` 进程在连接前以 exit 1 退出。
  - 证据来源：单测、`node build/index.js` 手工启动 probe
  - 结果：通过；stderr 含 `code: 'CONFIG_INVALID'` 和 `param: 'MCP_EXECUTION_PROFILE'`。
- [x] **S4** sandbox backend 不可用 → `sandboxed-production` 以 exit 1 终止并返回 `SANDBOX_UNAVAILABLE`，没有调用 local shell backend。
  - 证据来源：单测、当前 build 启动 probe
  - 结果：通过；stderr 含 `code: 'SANDBOX_UNAVAILABLE'` 和 `profile: 'sandboxed-production'`。
- [x] **S5** handler `extra` → `requestId/sessionId/signal` 映射到 context，arguments 同名字段不覆盖。
  - 证据来源：`tests/unit/wrap.test.ts` context pass-through、`tests/unit/hardening-contract.test.ts`
  - 结果：通过；runtime `requestId=99`、`sessionId=runtime-session` 和真实 signal 被 handler 收到。
- [x] **S6** `NaN`、`Infinity`、负数、小数、零边界和超最大值 → finite/int helper 按范围确定性拒绝/接受。
  - 证据来源：contract hostile-input 单测
  - 结果：通过。
- [x] **S7** `100evil`、`1e3`、负值和超过 `Number.MAX_SAFE_INTEGER` → strict integer 和 `envInt` 不再接受前缀/科学计数法/溢出。
  - 证据来源：`parseStrictInteger` / `envInt` 单测
  - 结果：通过。
- [x] **S8** ASCII 与多字节 Unicode → `boundedString` 同时按 code point 和 UTF-8 byte 判定。
  - 证据来源：bounded string 单测
  - 结果：通过。
- [x] **S9** 多 child 竞争 parent → child 不能超过 parent 剩余额度，queue/output 等不同 budget kind 不互相污染。
  - 证据来源：`BudgetAccount` parent/child 单测
  - 结果：通过。
- [x] **S10** parent deadline/signal abort → child signal 同步传播，后续 reserve 失败；已过期账本在构造时立即 aborted。
  - 证据来源：预算取消单测、过期账本回归单测
  - 结果：通过。
- [x] **S11** 重复 close、close 后 reserve、零额 reserve → close 幂等，关闭/取消后不再 reserve，合法零额不改变账本。
  - 证据来源：预算 close/reserve 单测
  - 结果：通过。
- [x] **S12** local capability → local 兼容能力允许；授权不来自 arguments。
  - 证据来源：capability policy 单测、wrapper context 单测
  - 结果：通过。
- [x] **S13** sandbox capability → shell、host process、environment、network 默认拒绝；声明的 argv capability 才允许。
  - 证据来源：sandbox capability matrix 单测
  - 结果：通过。
- [x] **S14** 错误兼容 → 既有错误码字符串保持，新增错误可通过 factory 构造，既有 `toCallToolResult` 对错误仍返回 `isError=true`。
  - 证据来源：`tests/unit/hardening-contract.test.ts`、`tests/unit/core.test.ts`、全量测试
  - 结果：通过。
- [x] **S15** 范围守护 → 新 feature 不新增 tool/resource/prompt，不改安全核心和依赖；完整质量门禁通过。
  - 证据来源：静态 scope/dependency/safety-core checks、`git diff --check`、`pnpm run gate`
  - 结果：通过。

本 feature 无前端改动，因此不适用浏览器肉眼验证。

## 4. 术语一致性

- [x] `ExecutionProfile`、`RequestContext`、`CapabilityPolicy`、`BudgetAccount` 在 design、源码、测试、architecture 和 acceptance 中保持同名同义。
- [x] `local-trusted-shell`、`sandboxed-production`、`CONFIG_INVALID`、`SANDBOX_UNAVAILABLE`、`CAPABILITY_DENIED` 的大小写和字符串值统一。
- [x] `src/context.ts` 仍只表示 usage-guide prompt 的会话上下文；新 `RequestContext` 只来自 `src/hardening-contract.ts` / `src/profile.ts`，没有术语混用。
- [x] `BudgetAccount` 的 `request/batch/child/session` scope、六种 `BudgetKind` 和 `deadlineAt` 语义在设计、代码和测试一致。
- [x] 禁用词/过度承诺检查通过：没有把应用层 capability、budget 或 profile 描述为已完成 OS sandbox；没有把本 feature 的 helper 描述为全部工具 schema 已接入。

## 5. 架构归并

已实际更新 `codestable/architecture/ARCHITECTURE.md`，不是只附 design 链接：

- [x] 项目简介和术语表加入 `ExecutionProfile`、`RequestContext`、`CapabilityPolicy`、`BudgetAccount`，并写明 sandbox backend 当前不可用。
- [x] 入口和模块索引记录 `src/index.ts` 的 startup profile gate、`src/hardening-contract.ts` 的共享契约、`src/profile.ts` 的 policy/context 和 `src/wrap.ts` 的 extra 映射。
- [x] ADR-19 记录 profile 固定、strict helper、parent/child ledger、错误码 additive compatibility 和不等于 OS sandbox 的边界。
- [x] 已知约束记录 `MCP_EXECUTION_PROFILE` 合法值、默认行为、进程级固定、sandbox fail-closed 和后续 feature 接入边界。
- [x] 架构文档的当前状态与代码一致：版本为 v4.0.0、默认工具数为 27（禁用 file_info 为 26），不把 roadmap 未来能力写成已完成。

本 feature 没有新增用户故事能力，因此不需要新增模块级 architecture 子文档。

## 6. requirement 回写

- [x] design frontmatter 的 `requirement` 为空，且本 feature 是现有工具能力的生产边界基础，不新增独立用户可见故事。
- [x] 无需创建或更新 `codestable/requirements/` 文档；后续 command/process/path/network 等产生用户可感行为时，在各自 acceptance 阶段按 `cs-req` 规则回写。

结论：`requirement` 回写跳过，原因是“技术基础 feature、无新增用户故事”，不是遗漏。

## 7. roadmap 回写

- [x] 已打开 `codestable/roadmap/2026-08-28-production-hardening/production-hardening-items.yaml`，找到 `slug: hardening-contract-and-profiles`。
- [x] 已将该条目的 `status` 从 `in-progress` 改为 `done`，保留 `feature: 2026-08-28-hardening-contract-and-profiles` 和依赖信息。
- [x] 已同步 `production-hardening-roadmap.md` 第 6 节对应子 feature 状态为 `done`，并记录本次 acceptance 报告。
- [x] items YAML、主 roadmap 和 feature frontmatter 的 slug/feature/status 已交叉校验一致。

后续可执行入口是 `process-supervisor-and-cancellation`；其依赖现在已满足，但它仍未实现，不能把 roadmap 总体状态误报为完成。

## 8. AGENTS.md / CLAUDE.md 候选盘点

本 feature 未擅自修改 `AGENTS.md` / `CLAUDE.md`，因为项目约定要求候选先登记、由 `cs-note` 单独执行落档；同时 roadmap 的 `docs-and-architecture-closeout` 还负责最终版本/发布形态口径。

- 候选 1：在 `AGENTS.md` 的“关键技术事实”中补充 `MCP_EXECUTION_PROFILE` 的合法值、默认 local、sandbox unavailable fail-closed 和不可由 tool arguments 切换。建议在最终文档收口 feature 中统一写入，避免与 v4.0.0/27 tools 一起重复修订。
- 候选 2：在 `AGENTS.md` 的“已知坑”中补充“`BudgetAccount` 是应用层共享账本；请求默认额度必须由具体执行 feature 配置，wrapper 不得猜默认值”。建议与后续 budget 接入完成后由 `cs-note` 查重落档。

当前不把一次性实现细节、测试数字或 acceptance 偏差修复写入 AGENTS；这些已在本报告和 architecture 中有可追溯证据。

## 9. 遗留

**本 feature 内部遗留**：

- 无未处理的设计/实现偏差；checklist 的 6 个 steps 和 10 个 checks 全部为完成/通过。
- request budget 的真实默认额度、工具级 schema 接入和执行 backend 仍刻意留给后续 feature，不属于本 feature 的未完成尾项。

**后续 roadmap 项目**：

- `process-supervisor-and-cancellation`：纳管全部 child process、取消、timeout、process tree 和 shutdown drain。
- `bounded-command-execution`：把当前 helper 接入三个命令工具的输入、输出、batch、queue、response 和 cancellation budget。
- `kill-process-identity`：修复 wildcard/PID reuse/重名进程终止风险。
- `path-policy-no-follow`、`secret-redaction-and-state-protection`、`network-and-archive-safety`、`audit-health-and-state-writer`：分别闭合路径、秘密、SSRF/archive、状态/审计边界。
- `tool-wrapper-and-surface-contract`、`search-and-adaptive-correctness`：完善异常转换、工具 surface 一致性、partial-result truthfulness 和搜索退化行为。
- `dependency-and-bootstrap-release`、`security-and-mcp-conformance-gates`、`docs-and-architecture-closeout`：解决依赖审计、source/npm bootstrap、发布证明、MCP conformance、CI gate 和最终文档同步。

**整体项目当前仍未达到无条件生产标准**：原始审计指出的高危进程 wildcard、生产依赖审计失败、npm/source bootstrap 不一致、全工具资源上限、路径 race、秘密落盘、SSRF/archive、child process 生命周期和 conformance/release gate 等问题仍由上述 roadmap 项目承接。本验收只解除第一条共享契约的依赖阻塞，不解除这些 release stop。

## 验收结论

`hardening-contract-and-profiles` 已完成实现、验收和 CodeStable 回写，状态为 `done`。在本次多轮核对中发现的偏差均已先修复再通过验收；当前 feature 范围内没有新的未归属、未验证或未记录问题。

### 实际验证证据

| 验证项 | 实际结果 |
|---|---|
| `pnpm run build` | 通过 |
| `pnpm exec tsc --noEmit` | 通过 |
| `pnpm run lint` | 通过，Biome 96 files 无修复 |
| `pnpm test`（gate 内） | 通过，49 files / 615 tests |
| `pnpm run test:latency` | 通过，24/24 |
| `pnpm run test:coverage` | 通过，48 files / 591 tests；Statements 85.06%、Branches 76.54%、Functions 90.28%、Lines 88.09% |
| `pnpm run test:coverage:tools` | 通过，7 files / 49 tests；Statements 60.00%、Branches 49.66%、Functions 63.91%、Lines 63.00% |
| targeted contract/wrapper tests | 通过，2 files / 16 tests；补充 profile 空白/超长和过期 budget 回归后仍通过 |
| invalid profile startup probe | exit 1，`CONFIG_INVALID`，未连接 transport |
| unavailable sandbox startup probe | exit 1，`SANDBOX_UNAVAILABLE`，未静默降级 |
| scope/dependency/safety-core/static checks | 全部通过 |
| `git diff --check` | 通过 |

未执行 `git commit`；用户尚未明确授权提交。所有本次主动写入、测试临时数据和 npm 缓存均位于非 C 盘项目目录下。
