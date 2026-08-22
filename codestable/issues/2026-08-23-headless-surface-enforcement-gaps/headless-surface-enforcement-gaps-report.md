---
doc_type: issue-report
issue: 2026-08-23-headless-surface-enforcement-gaps
status: resolved
severity: P1
resolution_date: "2026-08-23"
summary: off+headless 组合下 headless surface 不生效；make_directory 逃逸 surface；安全拒绝不入审计；过期 preview 不清理
tags: [security, headless, safeguard, audit, workspace-delete]
created: "2026-08-23"
---

# headless surface 执行与可观测性缺口 Issue Report

## 1. 问题现象

对 2026-08-23-harness-headless-safety feature 的授权机制审查发现四个缺口：

1. **F1（P1）**：`MCP_SAFETY_MODE=off` + `MCP_CONFIRMATION_MODE=headless` 组合下，headless surface 完全不生效——`execute_command` / `batch_execute` / `watch_command` / `copy_move` / archive / download / `kill_process` 照常执行；仅 `write_file` 因 `src/tools/files.ts` 的内联排除检查被拦。health 资源仍报告 `headless_surface: "workspace-delete"`，与实际行为不符。
2. **F2（P2）**：`make_directory` 无 headless 排除检查，headless 模式可在 `MCP_ALLOWED_ROOTS` 之外创建目录（含递归建父目录）。
3. **F3（P3）**：confirmation 层的安全拒绝（`ELICITATION_REQUIRED` / `ELICITATION_CANCELLED` / `headless_surface` 的 `SAFETY_BLOCKED`）不写审计记录，与 design acceptance 21（`MCP_AUDIT_MODE=all` 时拒绝可区分 decision/error_code）不符；成功路径有 `authorization_source=headless`，路径硬底线拒绝有审计。
4. **F4（P3）**：`previews` Map 只在使用时删除，过期条目滞留至进程重启，数量无上界（单条记录小，缓慢内存增长）。

## 2. 复现步骤

- **F1**：以 `MCP_SAFETY_MODE=off` + `MCP_CONFIRMATION_MODE=headless` + 合法 `MCP_ALLOWED_ROOTS` 启动 server，调用 `execute_command` → 命令执行（期望 `SAFETY_BLOCKED`）。
- **F2**：headless 模式调用 `make_directory`，目标在 roots 之外 → 目录创建成功（期望 `SAFETY_BLOCKED`）。
- **F3**：headless 模式调用 `copy_move` → 返回 `SAFETY_BLOCKED`，`MCP_AUDIT_MODE=all` 下 audit.jsonl 无对应记录。
- **F4**：连续调用 `delete_preview` 多次不提交 → 过期条目常驻内存。

复现频率：稳定。当前 e2e 只覆盖 `normal+headless`（`tests/workspace-delete.test.ts:10` 默认参数），上述组合无测试。

## 3. 期望 vs 实际

**期望行为**：README/design 工具矩阵口径——headless surface 固定为 workspace-delete，非 delete 工具一律 `SAFETY_BLOCKED`；`MCP_SAFETY_MODE` 是风险策略轴，`MCP_CONFIRMATION_MODE` 是确认通道轴，surface 边界由后者建立，不被 off 消解；安全拒绝可审计；过期 preview 被回收。

**实际行为**：见第 1 节。

## 4. 根因分析

- **F1**：`src/safeguard.ts` `evaluateDestructiveAction` 的 `off` 早退（:149-151）位于 headless 分支（:162-165）之前。design 自身矛盾：§2.2 流程图 `off → 直接执行`（confirmation mode 仅从 normal 分支进入），同节矩阵称这些工具 headless 下"拒绝"且"固定"。实现跟随了流程图。design §4 预期 harness 从旧 off 探针迁移到 headless profile，迁移忘删 off 是高概率人为错误，方向为 fail-open。
- **F2**：design 工具矩阵漏列 `make_directory`，实现镜像了 design 缺口（handler 仅 `validatePath` 硬底线）。
- **F3**：`manage.ts` `decisionFailure`（:28-57）与 `files.ts:173` 内联拒绝均无 `audit.record`；`wrapHandler` 只做 telemetry。
- **F4**：`workspace-delete.ts` 只在提交时 `previews.delete(previewId)`（:280），无过期清扫。

## 5. 严重程度

P1（F1）/ P2（F2）/ P3（F3、F4）。F1 需要操作者显式配置组合才触发，但该组合恰是 design 预期的迁移路径；不涉及远程攻击者，属授权边界被配置组合静默消解。

## 6. 修复方案（已获用户批准，含安全核心显式授权）

- **S1**：`evaluateDestructiveAction` 分支重排为 **strict → headless surface → off → normal/auto elicitation**；裁决跟随 design 矩阵（surface 固定）而非流程图；`initSafeGuard` 对 `off+headless` 组合输出启动告警；纯 off（不设 confirmation mode）行为不变。不采用"off+headless 拒绝启动"方案（避免新增 fatal 配置规则，保留组合可用性）。
- **S2**：`make_directory` handler 增加 `isHeadlessExcludedTool` 排除（同 `write_file` 模式）；不加入 `GUARDED_TOOLS`（mkdir 非破坏性，strict/桌面语义不变）。裁决记录：`session_state` / `cache_invalidate` 属会话/缓存运维面，不属于文件系统授权边界，维持可用。
- **S3**：`evaluateDestructiveAction` 对非 allow 决策统一 `audit.record`（`action=safety.decision`，detail 含 decision/reason|source/confirmation_mode/error_code，无 secret）；`files.ts` 内联拒绝单独补记；同 commit 更正 harness-headless-safety acceptance 文档 A21 条目的不准确表述。
- **S4**：`createDeletePreview` 插入前清扫过期条目，不引入后台定时器。
- **F5（不修）**：elicitation 模式的 capability 预检与 design §1.4"能力缺失按不支持处理"一致，维持现状；旧客户端兼容放宽如需另立 roadmap item。

## 7. 验证计划

- unit：分支重排后 `off+headless` 逐工具决策；非 allow 决策的审计记录；preview 过期清扫（`vi.setSystemTime`）。
- e2e：`off+headless` 下 execute_command / copy_move / make_directory → `SAFETY_BLOCKED`；根内合法 preview 的 delete_path 成功；strict+headless 的 delete_path 被 strict 拦；纯 off 的 execute_command 仍放行（兼容无回归）。
- 门禁：`pnpm run build` / `pnpm exec tsc --noEmit` / `pnpm run lint` / `pnpm test` / `pnpm run test:latency` 全绿后回写 README / ARCHITECTURE ADR-5 / CHANGELOG（Unreleased·Fixed）并 scoped commit。

## 8. 解决记录

2026-08-23 按 S1–S4 修复并验证：

- **S1**：`src/safeguard.ts` 决策顺序重排为 strict → headless surface → off；`initSafeGuard` 对 off+headless 组合输出启动告警；纯 off 行为不变。
- **S2**：`src/tools/files.ts` `make_directory` 接入 `headlessSurfaceBlock`（与 `write_file` 同一内联模式）。
- **S3**：`src/safeguard.ts` `auditSafetyDecision` 统一记录非 allow 决策（`action=safety.decision`，无 secret）；`files.ts` 内联拒绝同规格补记；harness-headless-safety acceptance 文档 A21 更正。
- **S4**：`src/workspace-delete.ts` `sweepExpiredPreviews` 在每次创建 preview 前清扫过期记录。
- **验证**：新增 unit 7 例（off+headless 决策、strict 优先、纯 off 兼容、审计三类决策、allow 不审计、preview 清扫）+ e2e 5 例（off 面、make_directory、off 下合法删除、strict 拦截、纯 off 命令兼容）；全量 42 文件 / 571 用例 + latency 24/24 全绿。
- **F5 不修**：elicitation capability 预检与 design §1.4 "能力缺失按不支持处理" 一致，维持现状。
