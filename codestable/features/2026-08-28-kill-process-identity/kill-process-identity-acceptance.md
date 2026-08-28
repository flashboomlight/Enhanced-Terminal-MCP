---
doc_type: feature-acceptance
feature: 2026-08-28-kill-process-identity
requirement: ""
roadmap: production-hardening
roadmap_item: kill-process-identity
status: done
summary: 对照进程身份设计完成验收；关闭 kill_process 的 wildcard、重名、PID reuse 和裸 name termination 风险，完成真实 Windows probe、受控 tree termination、回归测试、架构和 roadmap 回写
tags: [security, process, identity, kill, windows, unix, acceptance]
created: "2026-08-28"
last_reviewed: "2026-08-28"
---

# kill-process-identity 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-28
> 关联方案 doc：`codestable/features/2026-08-28-kill-process-identity/kill-process-identity-design.md`
> 关联 checklist：`codestable/features/2026-08-28-kill-process-identity/kill-process-identity-checklist.yaml`
> 验收授权：用户已明确要求继续执行并由本代理代为完成审核；本报告按当前代码、静态检查、测试和实际平台 probe 完成终审记录。

## 1. 接口契约核对

对照 design 第 2.1 节名词层和第 2.2 节编排层逐项核查。

**接口示例逐项核对**：

- [x] `KillTarget`：`src/process-identity.ts` 将目标收敛为 `pid` 或 `exactName` 二选一，并保留 `force`；调用方不能提交 identity token/start time。
- [x] `ProcessIdentity`：包含 `pid`、`name`、`startedAt`、opaque `token`、`ownedByCurrentWorker` 和可选 `processGroupId`；provider 输出经过字段边界校验。
- [x] `ProcessIdentityProvider`：提供 `findByExactName`、`inspectPid`、`terminate`；系统 handler 通过可选依赖注入使用默认 provider 或 fake provider。
- [x] strict input helper：`kill_process` schema 使用 `finiteInt(1, 2147483647)` 和 `boundedString(128, 512)`；handler 再次调用 `parseKillTarget`，直接调用也不会绕过 XOR/wildcard 检查。
- [x] structured error mapping：缺参/双目标/非法输入为 `VALIDATION_ERROR`；零候选为 `NOT_FOUND`；重名、PID reuse、proof 不可用为 `PROCESS_IDENTITY_AMBIGUOUS`；tree/graceful 终止失败保持明确错误。
- [x] success envelope：`kill_process` 成功返回 `killed`、实际 identity 的 `pid/name` 和 `tree`，`outputSchema` 已同步声明 `tree`。

**名词层“现状 → 变化”逐项核对**：

- [x] 原先 `pid/name` 都 optional 且 name 可直接进入系统命令 → 现在严格 XOR，name 先精确枚举，provider 只使用 verified identity。
- [x] 原先 `getKillSpec` 可生成 `/IM` 或 `pkill` → 现在 `getKillSpec` 只接受 verified PID，name 不再参与 command spec 构造。
- [x] 原先没有启动时间/token → Windows 使用 Process start time/Process handle 绑定，Linux 使用 `/proc` start-time token，macOS 使用固定 `ps` probe + recheck。
- [x] 原先命令成功即报告 killed → 现在 provider 在有界窗口内确认目标 identity 消失，否则返回结构化失败。

**验收期间发现并已修复的偏差**：

- Windows `execFile` 的 argv 是字符串，PowerShell `[bool]` 参数不能直接接收 `"True"`；已改为字符串参数并在固定脚本内严格解析，真实受控 tree termination 已通过。
- Windows PID 不存在时实际异常类型不是预期的 `ArgumentException`；已改为固定脚本显式返回 `not-found`，真实 missing-PID probe 返回 `NOT_FOUND`。
- `force=false` 的 Windows 无 GUI 分支原先会调用 `Kill()`；已改为 `graceful-unsupported`，要求调用方显式 `force=true`。
- provider 返回的 name/start/group 字段最初校验不足；已补充 identity record 校验，异常字段 fail-closed。
- 成功结果新增 `tree` 后已同步 `kill_process` output schema；既有 critical-process 文本中的 `critical system process` 兼容关键词也已恢复。

## 2. 行为与决策核对

**需求摘要逐项验证**：

- [x] 目标严格唯一：handler 在 provider 前拒绝缺参、双目标、wildcard、路径字符、控制字符、超长名称和非法 PID。
- [x] name 路径精确枚举：零候选不执行，多个候选不自动选择第一个，必须改用 PID。
- [x] PID 路径 identity proof：先 inspect，再由 provider 在终止边界内重验 token/start time。
- [x] 保护优先：关键进程、当前 server、parent 和当前 process group 均不会进入终止副作用。
- [x] force/tree 语义：`force=false` 不请求 tree；`force=true` 请求已验证的 Windows process tree 或 Unix process group。
- [x] 成功诚实：终止后仍存在、identity 发生变化、权限失败、平台能力不足均不会返回 `killed=true`。
- [x] SafeGuard 保留：identity workflow 复用既有 `guardDestructiveAction`，没有修改 strict/normal/off、risk-gated 或 hardBlock 规则。

**明确不做逐项核对**：

- [x] 没有实现全局 process supervisor、active child registry、统一 cancellation 或 shutdown drain；这些仍由 `process-supervisor-and-cancellation` 负责。
- [x] 没有修改 `DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、command policy 或关键进程名单。
- [x] 没有改变 `process_list`、`network_info`、`environment_vars` 既有业务语义。
- [x] 没有新增 MCP tool/resource/prompt、运行时依赖或非本 feature 的文件/网络/秘密行为。

**关键决策落地**：

- [x] D1 目标互斥：旧的 PID 优先行为已删除，双目标返回 `VALIDATION_ERROR`。
- [x] D2 精确名称：不再使用操作系统 name matching；唯一候选后才创建 identity。
- [x] D3 proof 绑定：user arguments 不携带 token；provider 负责 probe/recheck/terminate。
- [x] D4 平台不足 fail-closed：Windows tree method、Unix group/start proof 不可用时返回失败。
- [x] D5 保护优先：输入和 actual identity 均检查 critical/self/parent/process group。
- [x] D6 成功可观察：provider 对目标消失进行有界确认，不能用 command exit 0 代替。
- [x] D7 错误扩展兼容：复用既有错误码字符串和 `isError` 转换，不改旧错误码值。

**跨层纪律**：

- [x] 所有终止副作用之前完成 input、critical/self/parent 和 identity 校验。
- [x] 终止命令只使用固定 PowerShell script + argv 或 Node signal；用户 name 不插入脚本文本。
- [x] Windows 生产路径只使用 PID/Process object，Unix 生产路径不使用 `pkill`。
- [x] 原始系统错误被映射为有限错误原因，不把 PowerShell/系统 stderr 作为用户 detail 返回。
- [x] fake provider 能验证 reject/ambiguous/mismatch/protected 场景没有调用 terminate。

**挂载点反向核对（可卸载性）**：

- [x] M1 `kill_process` boundary：`src/tools/system.ts` 负责 strict input、保护、SafeGuard、provider 编排和结果转换。
- [x] M2 default provider：`src/process-identity.ts` 负责平台 probe、精确枚举、proof-bound termination 和退出确认。
- [x] M3 `getKillSpec`：`src/platform.ts` 只保留 PID-only command spec，不再有 name branch。
- [x] M4 test seam：`registerSystemTools` 的 `SystemToolDependencies` 接受 fake provider，相关测试不触发真实 kill。
- [x] M5 error surface：使用既有 `VALIDATION_ERROR`、`NOT_FOUND`、`PROCESS_PROTECTED`、`PROCESS_IDENTITY_AMBIGUOUS`、`PROCESS_TREE_TERMINATION_FAILED` 和 `EXECUTION_FAILED`。
- [x] 反向 grep：`src/` 中所有 `getKillSpec` 引用已收敛到 PID-only platform tests；`kill_process` 的实际终止入口只有 provider，不存在额外 name kill 挂载点。
- [x] 拔除沙盘推演：移除该 feature 时需移除 provider 模块、system handler 依赖、PID-only spec 变更、对应测试和 roadmap/docs 挂载；没有发现隐藏注册或额外工具 surface。

## 3. 验收场景核对

对照 design 第 3 节 15 条关键场景逐条验证。

- [x] **S1** `{}` → `VALIDATION_ERROR`，不进入 provider。
  - 证据：`parseKillTarget` 单测、system fake provider 测试。
  - 结果：通过。
- [x] **S2** 同时提供 `pid` 和 `name` → `VALIDATION_ERROR`，不再静默 PID 优先。
  - 证据：输入单测和 system handler 测试。
  - 结果：通过。
- [x] **S3** `NaN`、`Infinity`、小数、负数、0、超上限 PID → `VALIDATION_ERROR`。
  - 证据：`process-identity.test.ts`。
  - 结果：通过。
- [x] **S4** 空白、超长、wildcard、路径分隔符、控制字符 name → `VALIDATION_ERROR`，不静默 sanitize。
  - 证据：`isExactProcessNameValid` / `parseKillTarget` 单测。
  - 结果：通过。
- [x] **S5** 精确名称无候选 → `NOT_FOUND`，不 terminate。
  - 证据：`findUniqueIdentity` 编排和 provider contract；missing-PID 实际 probe 为 `NOT_FOUND`。
  - 结果：通过。
- [x] **S6** 精确名称多个候选 → `PROCESS_IDENTITY_AMBIGUOUS`，不 terminate。
  - 证据：fake provider system 测试；当前环境对 `node` 的精确枚举也返回多个候选并拒绝自动选择。
  - 结果：通过。
- [x] **S7** PID/name 唯一候选 → 取得非空 token/start time，实际 current-process probe 成功。
  - 证据：Windows `defaultProcessIdentityProvider.inspectPid(process.pid)` probe、Windows/Linux/macOS parser 单测。
  - 结果：通过。
- [x] **S8** 终止前 proof 变化或不可用 → `PROCESS_IDENTITY_AMBIGUOUS`，不 terminate。
  - 证据：fake provider mismatch 测试、`sameProcessIdentity` PID reuse 测试。
  - 结果：通过。
- [x] **S9** Windows 不生成 `/IM`，Unix 不生成 `pkill`。
  - 证据：PID-only `getKillSpec` 单测和源码静态 grep。
  - 结果：通过。
- [x] **S10** `force=false/true` 的范围可观察；tree 能力不足返回 tree failure。
  - 证据：fake handler 调用参数、真实 Windows `force=true/tree=true` 受控 child probe、固定脚本 status 分支。
  - 结果：通过。
- [x] **S11** 终止报告成功但目标仍存在 → provider 不返回成功。
  - 证据：Windows/Unix post-termination identity check 代码和 failure path。
  - 结果：通过。
- [x] **S12** critical/self/parent/process group → `PROCESS_PROTECTED`，不调用 provider terminate。
  - 证据：system unit tests、既有 safeguard tests、实际当前 server PID protection。
  - 结果：通过。
- [x] **S13** fake provider/executor → 拒绝路径的调用顺序可断言。
  - 证据：system tests 的 `vi.fn` 调用断言。
  - 结果：通过。
- [x] **S14** 旧错误码和 MCP `isError` 兼容，新 identity/tree 错误可构造。
  - 证据：result/core tests、full test、现有 `PROCESS_PROTECTED` 文本兼容回归。
  - 结果：通过。
- [x] **S15** 不新增 MCP surface、不改安全核心和依赖。
  - 证据：scope/dependency/safety-core 静态检查、package diff、完整 gate。
  - 结果：通过。

本 feature 无前端改动，不适用浏览器验证。

## 4. 术语一致性

- [x] `KillTarget`、`ProcessIdentity`、`ProcessIdentityProvider`、`identity proof`、`tree termination` 在 design、源码、测试和 architecture 中同名同义。
- [x] `exactName` 表示已验证的精确 basename，不再与 `sanitizeProcessName` 混用；后者仍只服务 `process_list`。
- [x] `PROCESS_IDENTITY_AMBIGUOUS` 表示身份不唯一/不可靠，`PROCESS_TREE_TERMINATION_FAILED` 表示树终止未完成，未混用为普通成功或 no-op。
- [x] `force=true` 与 `tree=true` 的关系在 design、handler 和 provider 中一致；`force=false` 不自动扩大到 process group/tree。
- [x] 没有在文档中把单工具 provider 宣称为全局 process supervisor 或 OS sandbox。

## 5. 架构归并

已实际更新 `codestable/architecture/ARCHITECTURE.md`：

- [x] 术语表新增 `ProcessIdentity` 和 `ProcessIdentityProvider`。
- [x] `src/tools/system.ts` 的职责说明更新为严格 PID/name XOR、provider、critical/self/parent protection。
- [x] 模块索引新增 `src/process-identity.ts`，说明 Windows/Linux/macOS probe、token、PID-only/tree termination 和 fail-closed。
- [x] ADR-20 记录精确枚举、start-time/token recheck、无 `/IM`/`pkill`、force/tree 语义和与后续 supervisor 的边界。
- [x] 安全硬边界加入 kill_process identity proof、protected target 和禁止裸 name matching。

架构文档没有提前把全局 process supervisor、统一 cancellation 或 shutdown drain 写成已完成。

## 6. requirement 回写

- [x] design frontmatter 的 `requirement` 为空，本 feature 是既有 `kill_process` 的安全边界修复，不新增独立用户故事。
- [x] 无需创建或更新 `codestable/requirements/` 文档；后续如果调整用户可见的进程管理能力边界，再由对应 feature acceptance 触发 `cs-req`。

结论：requirement 回写跳过，原因是“既有能力的安全收敛”，不是遗漏。

## 7. roadmap 回写

- [x] `production-hardening-items.yaml` 中 `kill-process-identity` 已从 `in-progress` 更新为 `done`，feature 绑定保持为 `2026-08-28-kill-process-identity`。
- [x] `production-hardening-roadmap.md` 第 6 节已同步为 `状态：done`，并链接本 acceptance 报告。
- [x] 变更日志已记录 implementation/acceptance 和期间修复的参数、状态、保护及兼容边界。
- [x] items YAML、主 roadmap、design、checklist 和 acceptance 的 slug/status/依赖一致。

下一项可执行 feature 是 `process-supervisor-and-cancellation`；它仍然负责全局 child process lifecycle，不因本 feature 完成而自动变成 done。

## 8. AGENTS.md / CLAUDE.md 候选盘点

本 feature 没有擅自修改 `AGENTS.md` / `CLAUDE.md`；候选交由 `cs-note` 或最终文档收口处理：

- 候选 1：补充 `kill_process` 的硬约束——PID/name 二选一、名称必须精确唯一、不能使用 `/IM`/`pkill`、PID 必须有 identity proof。
- 候选 2：补充 Windows PowerShell provider 的参数规则——脚本参数通过 argv 传入，布尔值必须在固定脚本内部解析，不能把用户值插入脚本文本。
- 候选 3：补充“`sanitizeProcessName` 只用于展示/查询过滤，破坏性目标必须 reject-style validation”的区分。

一次性实现细节和本轮测试数字保留在 acceptance/architecture，不写入 AGENTS。

## 9. 遗留

**本 feature 内部遗留**：

- 无未处理的设计/实现偏差；5 个 steps 和 10 个 checklist checks 全部完成/通过。
- Windows 当前 provider 已用 Process start time + Process object 绑定；Linux 使用 `/proc` start-time/process group；macOS 使用固定 `ps` probe/recheck。无法取得或解析 proof 时统一 fail-closed。
- 全局 process supervisor 尚未接入其它 `spawn`/`execFile` 路径；这是明确的后续边界，不是本 feature 的隐藏尾项。

**后续 roadmap 项目**：

- `process-supervisor-and-cancellation`：统一纳管全部 child process、timeout、AbortSignal、后代进程和 shutdown drain。
- `bounded-command-execution`：把 `BudgetAccount` 和 cancellation 接入三个命令工具。
- `path-policy-no-follow`、`secret-redaction-and-state-protection`、`network-and-archive-safety`：继续闭合文件、秘密、网络和归档边界。
- `audit-health-and-state-writer`、`tool-wrapper-and-surface-contract`、`search-and-adaptive-correctness`：完成状态 writer、MCP surface、partial result 和搜索退化治理。
- `dependency-and-bootstrap-release`、`security-and-mcp-conformance-gates`、`docs-and-architecture-closeout`：解决依赖审计、npm/source bootstrap、CI、conformance、供应链和最终文档收口。

**整体项目仍未达到无条件生产标准**：当前 `pnpm audit --prod` 的已知结果仍为 exit 1（4 high、6 moderate、2 low），npm/source bootstrap 仍未完全分离，资源预算、全局 child lifecycle、路径 race、秘密落盘、SSRF/archive 和 MCP/release gate 仍是发布阻断。

## 验收结论

`kill-process-identity` 已完成实现、验收和 CodeStable 回写，roadmap 状态为 `done`。本轮对抗性复核中发现的实现问题均已先修复再验收；当前 feature 范围内没有新的未归属、未验证或未记录问题。

### 实际验证证据

| 验证项 | 实际结果 |
|---|---|
| `pnpm run build` | 通过 |
| `pnpm exec tsc --noEmit` | 通过 |
| `pnpm run lint` | 通过，Biome 检查 98 个文件，无修复 |
| `pnpm test`（gate 内） | 通过，50 files / 628 tests |
| `pnpm run test:latency` | 通过，24/24 |
| `pnpm run test:coverage` | 通过，49 files / 604 tests；Statements 81.38%、Branches 73.75%、Functions 86.33%、Lines 84.90% |
| `pnpm run test:coverage:tools`（gate 内） | 通过，7 files / 54 tests；Statements 61.05%、Branches 50.90%、Functions 63.63%、Lines 64.00% |
| identity/system/platform targeted tests | 通过，5 files / 81 tests |
| Windows current-process probe | 成功取得 `windows:` start-time token，当前进程被识别为 server-owned |
| missing-PID probe | 返回 `NOT_FOUND`，不执行终止 |
| graceful child probe | 返回 `EXECUTION_FAILED` / `graceful-unsupported`，未误报成功 |
| force tree child probe | 受控短生命周期 child 成功终止，post-termination 确认通过 |
| scope/dependency/safety-core checks | 全部通过 |
| CodeStable YAML/frontmatter checks | acceptance、design、checklist、items、roadmap、architecture 和 compound 校验通过 |
| `git diff --check` | 通过 |

未执行 `git commit`；用户尚未明确授权提交。所有本次任务控制的代码、文档、build、测试临时数据和缓存均位于 D 盘或其它非 C 盘位置。
