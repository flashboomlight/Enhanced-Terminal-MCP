---
doc_type: feature-acceptance
feature: 2026-08-23-harness-headless-safety
status: done
summary: 对照 design 完成 MCP_CONFIRMATION_MODE 三态确认通道、MCP_ALLOWED_ROOTS headless 边界、preview 绑定的 workspace-delete 与协议级 harness e2e 验收
tags: [security, harness, headless, elicitation, workspace-delete, acceptance]
created: "2026-08-23"
---

# harness-headless-safety 验收报告

> 阶段：验收闭环
> 验收日期：2026-08-23
> 关联方案 doc：`harness-headless-safety-design.md`

## 1. 接口契约核对

对照 design 第 2.1 节名词层与第 2.2 节编排层逐项核对。

**名词层 / 类型契约**：

- [x] `ConfirmationMode = "elicitation" | "headless" | "auto"`：`src/safeguard.ts:10`；解析默认 `elicitation`、非法值回退并告警：`src/safeguard.ts:114-122`。
- [x] 结构化 `SafetyDecision`（allow/required/declined/blocked 四态，blocked 含 `headless_surface` reason）：`src/safeguard.ts:12-16`。
- [x] 错误码映射互斥：`ELICITATION_REQUIRED`（`src/result.ts:28`、`src/tools/manage.ts:30`，detail 带 `clientSupportsElicitation` 与恢复建议）、`ELICITATION_CANCELLED`（`src/tools/manage.ts:43`）、`SAFETY_BLOCKED`（`src/tools/manage.ts:50`，detail 带 reason + confirmation_mode）、stale preview → `VALIDATION_ERROR` retryable（`src/workspace-delete.ts:265-267`）。
- [x] `meta.safety_protocol_version: 2`：类型声明 `src/result.ts:113`；feature-owned envelope 注入 `src/tools/manage.ts:26`、`:236`、`:287`、`:293`；`_meta` 透传 `src/result.ts:344`。
- [x] `HeadlessRoot` / `HeadlessPolicySummary` / `HEADLESS_CONFIG_ERROR`：`src/headless-policy.ts:10-21`。
- [x] `DeleteSnapshot`（`sha256-lstat-v1`）/ `DeletePreview` / `WorkspaceDeleteErrorCode`：`src/workspace-delete.ts:15-35`。

**编排层 / 挂载点反向核对**：

- [x] M1 确认决策层：`src/safeguard.ts`（mode 优先级 strict > confirmation mode；headless 分支 `:162-164`：`delete_path` → allow(headless)，其余 → blocked(headless_surface)）。
- [x] M2 headless 边界层：`src/headless-policy.ts`（`initHeadlessPolicy` `:80`、严格后代匹配 `validateHeadlessDeleteTarget` `:120`、reparse 检查 `hasReparsePath` `:39`）；启动接线 `src/index.ts:43`。
- [x] M3 递归删除计划层：`src/workspace-delete.ts`（`createDeletePreview` `:232`、`deleteWithPreview` `:272`、entry/time 预算 `:89-102`、TTL `:239`、进程内一次性 token Map `:72`）。
- [x] M4 能力与审计层：health 资源 capability 摘要（e2e 证据见 S20）；审计 `authorization_source=headless` + `safety_protocol_version`：`src/tools/manage.ts:280-290`，只记 path/type，无 secret 原文。
- [x] 反向 grep：`MCP_CONFIRMATION_MODE` / `MCP_ALLOWED_ROOTS` / `safety_protocol_version` 的生产引用均落在 safeguard / headless-policy / workspace-delete / manage / result / index 清单内，无额外挂载点。
- [x] 拔除沙盘：移除以上四层与两个新源文件、manage.ts 的 preview 分支、测试文件后，feature 行为完全消失；旧 `MCP_SAFETY_MODE` 三态与 Elicitation 路径不受影响。

## 2. 行为与决策核对

**锁定决策（design 第 5 节）落地**：

- [x] headless 强制有效 `MCP_ALLOWED_ROOTS`，无"无根 delete profile"：`src/headless-policy.ts:80-96`（缺失/空项/相对路径/非目录 fail-closed）；`tests/unit/headless-policy.test.ts:50`。
- [x] headless surface 只有 workspace-delete；write/copy/archive/command/network/process 全拒：`src/safeguard.ts:87-90`、`:162-164`；协议级证据 `tests/workspace-delete.test.ts:154`、`:176`。
- [x] target/父路径/递归树 reparse 全拒 + mutex 内复核快照：`src/headless-policy.ts:39`、`src/workspace-delete.ts:120`（快照比较在 `withMutationLock` `:251-263` 内）；`tests/unit/headless-policy.test.ts:70`、`tests/workspace-delete.test.ts:131`。
- [x] preview token 进程内 5min、单次原子消费：`src/workspace-delete.ts:72`（模块级 Map）、`:278-281`（get 后立即 delete 再校验）；重启/跨进程 id 天然无效（每 e2e 用例独立子进程服务器）。

**明确不做逐项核对**：

- [x] 未删除/削弱 `security.ts` 硬边界与 hardBlock：两个 delete 工具仍先走 `validatePath` + `validateRealPath`（`src/tools/manage.ts:79-87`、`:217-225`）；command policy 顺序未变。
- [x] 未把 `off` 设为默认或 harness 隐式降级；`auto` 无 Elicitation 时 fail-closed 返回 `ELICITATION_REQUIRED`（`tests/workspace-delete.test.ts:249`）。
- [x] 未用 `confirm: true` 之类请求参数授权：headless 授权只来自启动环境。
- [x] 未顺手开放其他 mutator：见 surface 排除证据。

## 3. 验收场景核对

对照 design 第 3 节 24 条。证据来源：`tests/unit/headless-policy.test.ts`（UH，5 用例）、`tests/unit/workspace-delete.test.ts`（UW，预算）、`tests/workspace-delete.test.ts`（E2E，10 用例，`StdioClientTransport` 真子进程协议级验证，即"真实无 Elicitation harness 证据"）、`tests/unit/safeguard.extended.test.ts`（US）、`tests/unit/security-corpus.test.ts`（安全语料）、`tests/e2e-latency.test.ts`（延迟回归）；全量 42 文件 / 558 用例于 2026-08-23 全绿。

- [x] **A1** 未设新变量的桌面 normal 行为不变：`US:27-51`（模式解析）、`E2E:230`；命令工具延迟阈值内（e2e-latency 24/24）。
- [x] **A2** elicitation 模式无 Elicitation 能力 → `ELICITATION_REQUIRED` + `clientSupportsElicitation=false`：`E2E:230`。
- [x] **A3** 客户端明确拒绝 → `ELICITATION_CANCELLED`（不是"不支持"）：`US:154-168`（declined 决策路径，manage.ts:43 映射）；文案含 cancelled，映射互斥。
- [x] **A4** auto 无能力 → `ELICITATION_REQUIRED`，不自动切 headless：`E2E:249`。
- [x] **A5** headless 配置缺失/空项/相对路径/无效目录 → 接受请求前 fail-closed：`UH:50`（缺失）；`src/headless-policy.ts:80-96` 逐项校验；reparse 根拒绝 `UH:70`。
- [x] **A6** 根内单文件删除成功 + 审计 `authorization_source=headless`：`E2E:52`；审计写入 `src/tools/manage.ts:280-290`。
- [x] **A7** 根外 / 根本身拒绝，相邻前缀不误判：`E2E:109`；严格后代边界 `UH:57`。
- [x] **A8** 任意 mode 系统目录/敏感路径/穿越拒绝：`security-corpus` 全量 + manage.ts 双 delete 入口的 `validatePath`/`validateRealPath` 前置。
- [x] **A9** delete_preview 单文件/空目录/非空目录契约与 recursive 规则：`E2E:52`（单文件）、`E2E:83`（递归目录）；schema `src/workspace-delete.ts:15-33`。
- [x] **A10** 正确 id 一次性删除；重复/过期/参数不匹配不执行：`E2E:83`；token 单次消费 `src/workspace-delete.ts:278-281`；stale 拒绝 `E2E:131`。
- [x] **A11** preview 后目标变化 → `VALIDATION_ERROR` + `preview_stale`，不删除：`E2E:131`。
- [x] **A12** normal 下三个命令工具行为不变：e2e-latency（execute/batch/watch 在阈值内）+ `US:137`（命令工具仍需确认）。
- [x] **A13** target/父路径/递归树 reparse → `SAFETY_BLOCKED` 无副作用；根 reparse 不接受请求：`UH:70`、`src/headless-policy.ts:39`。
- [x] **A14** headless 目标父路径不在根内 → 拒绝：`validateHeadlessDeleteTarget` 的父路径检查（`src/headless-policy.ts:120`）+ `UH:57` 边界逻辑。
- [x] **A15** structuredContent 字段完整（path/type/recursive/counts/total_bytes/snapshot/preview_id/expires_at）且 digest 为 `sha256-lstat-v1`：`E2E:52`/`:83` 断言 + `src/workspace-delete.ts:225`；canonical 序列化按 design 实现（UTF-8 排序、`/` 分隔、bigint lstat、小写 hex）。
- [x] **A16** 超 100000 条目或 30s → `VALIDATION_ERROR` 不生成 id：`UW:15`（时间预算）；条目预算 `src/workspace-delete.ts:89-93` 同一错误路径。
- [x] **A17** 复核与删除在同一进程 mutator mutex 内；跨进程 id 不被接受：`withMutationLock` `src/workspace-delete.ts:251-281`；进程内 Map `:72`；E2E 每用例独立子进程服务器，跨进程 id 无效为构造性保证；跨进程并发独占前提已在 design §2.2 条款 5 与本文档边界声明。
- [x] **A18** batch 整批预检契约不变：`security-corpus`（既有契约，本 feature 未改 command 入口）。
- [x] **A19** auto 读 initialize 能力，缺失/不支持 → `ELICITATION_REQUIRED`：`src/safeguard.ts:114-122` + `E2E:249`。
- [x] **A20** capability/health 摘要含 safety_protocol_version/safety_mode/confirmation_mode/elicitation_supported/allowed_roots/headless_surface，不泄完整 secret 或未授权路径：`E2E:215`；摘要结构 `src/headless-policy.ts:102`。
- [x] **A21** 审计区分 authorization_source/decision/error_code 且无 secret 原文：`src/tools/manage.ts:280-290`（成功）；拒绝路径走统一 audit 记录。
- [x] **A22** 重启后配置解析一致、旧 preview id 全失效：preview 存储为进程内 Map（`src/workspace-delete.ts:72`），重启即清空；headless 配置由启动 env 重新解析（`src/index.ts:43`）；E2E 每用例冷启动验证。
- [x] **A23** unset 新变量回到旧桌面 profile：`src/safeguard.ts:114` 默认 `elicitation`；`E2E:230` 兼容路径。
- [x] **A24** headless 调排除工具（write/copy/archive/command/network/process）→ `SAFETY_BLOCKED` 无副作用、不生成 preview id：`E2E:154`、`:176`。

**Explicitly rejected outcomes 核对**（全部未发生）：默认模式未被改成 off；边界匹配用规范化分隔符判断而非字符串前缀（`UH:57` 覆盖相邻前缀）；无 "user cancelled" 假文案（能力缺失返回 ELICITATION_REQUIRED，见 `E2E:230`/`:249`）；无 `confirm:true` 自授权；headless 未跳过 security/command policy/hardBlock；协议级兼容声明基于真实 StdioClientTransport 子进程 e2e 而非仅 `pnpm test`。

本项目无前端 UI，无浏览器验证项。

## 4. 术语一致性

- [x] `MCP_CONFIRMATION_MODE`（elicitation/auto/headless）、`MCP_ALLOWED_ROOTS`、`headless surface`、`workspace-delete` 在 README 环境变量表、AGENTS.md、ARCHITECTURE ADR-5/术语表、design 与本文档一致。
- [x] `ELICITATION_REQUIRED` / `ELICITATION_CANCELLED` / `SAFETY_BLOCKED` / `VALIDATION_ERROR(preview_stale)` 语义在 result.ts 错误码表、manage.ts 映射与 README/架构文档一致。
- [x] `sha256-lstat-v1`、`preview_id`、`delete_preview` 的 schema 字段名与 design 第 2.2 节 JSON 示例逐字段一致。
- [x] `safety_protocol_version: 2` 的兼容口径（旧客户端按 generic error 处理）在 design §4 与 README 一致。

## 5. 架构归并

- [x] `codestable/architecture/ARCHITECTURE.md`：术语表新增 ConfirmationMode/SafetyDecision/headless 相关条目；§3.2 新增 `headless-policy.ts` / `workspace-delete.ts` 模块行；ADR-5 更新为 normal 默认 Elicitation + headless 仅 preview-bound workspace-delete。
- [x] `AGENTS.md` 安全双层描述与 28 工具口径已同步（未新增工具，`delete_preview` 计入现有 28 面）。
- [x] `README.md`：环境变量表新增 `MCP_CONFIRMATION_MODE` / `MCP_ALLOWED_ROOTS`；File Management 节说明 headless 面。
- [x] `CHANGELOG.md` Unreleased 已记录 workspace-delete headless surface 条目。

## 6. requirement 回写

- [x] 不单独新建 requirement：本 feature 的用户可感知面（harness 无 UI 确认下的受控删除）已通过 README 配置文档与 ARCHITECTURE ADR-5 记录；按 shared-conventions，安全架构决策归 `codestable/compound/` 承载，不重复 requirement 文件。
