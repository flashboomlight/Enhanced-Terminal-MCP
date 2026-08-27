---
doc_type: decision
category: constraint
id: DEC-002
title: 确认模型收敛——拆除 headless surface，命令分级确认对齐官方 MCP 设计哲学
status: active
created: 2026-08-28
related:
  - ../features/2026-08-28-command-risk-gated-confirmation/command-risk-gated-confirmation-design.md
  - 2026-08-28-explore-safe-block-diagnosis.md
  - ../features/2026-08-23-harness-headless-safety/harness-headless-safety-design.md
  - ../issues/2026-08-23-headless-surface-enforcement-gaps/headless-surface-enforcement-gaps-report.md
  - 2026-07-11-decision-hardblock-uncloseable-baseline.md
  - 2026-07-12-decision-command-execution-not-sandbox.md
tags: [security, confirmation, headless, official-alignment, elicitation, risk-gated]
---

# 确认模型收敛——拆除 headless surface，命令分级确认对齐官方 MCP 设计哲学

## 背景

2026-08-23 的 harness-headless-safety feature 引入了 `MCP_CONFIRMATION_MODE=headless` 授权面：headless 下只保留 `delete_preview` + preview 绑定的 `delete_path`，其余工具全拒，边界由 `MCP_ALLOWED_ROOTS` 目录白名单约束。该机制在本机交互场景被误启用（`MCP_SAFETY_MODE=off` 与 `headless` 同时配置），由于 cda0ac7 将决策序定为"off 不消解 headless surface"，导致 `echo safe-block-probe` 这类无副作用命令也被 `headless_surface` 拦截，agent 几乎完全无法执行任何指令。实证诊断见 [explore-safe-block-diagnosis](2026-08-28-explore-safe-block-diagnosis.md)。

**官方 MCP 依据（2026-08 查证，规范版本 2026-07-28）**：

1. **Roots 机制已废弃**（SEP-2577）：规范原文 "informational guidance rather than an access-control mechanism. The protocol does not enforce that servers stay within roots"；新实现 SHOULD NOT 采用，迁移方向为工具参数 / 资源 URI / server 配置。目录白名单路线被官方放弃。
2. **文件系统限制的责任方是宿主**：安全最佳实践要求 client "Launch MCP servers with restricted access to the file system"、"Use platform-appropriate sandboxing technologies"；server 侧官方义务仅是用 stdio 传输限制接入方。目录笼子不是 server 的官方职责。
3. **危险操作的官方机制是 Elicitation 逐次确认**：运行时按次征求用户同意，client 必须提供 decline/cancel。
4. **scope minimization 反对一刀切**：规范明言 "Poor scope design increases... user friction"、导致 "Consent abandonment"；推崇 progressive/step-up 模型——低风险操作自由走，特权操作首次被尝试时才要求提权。

## 结论

**确认模型收敛为：`MCP_SAFETY_MODE` 三档（strict/normal/off）+ `MCP_COMMAND_CONFIRMATION=all|risk-gated` 命令分级 + Elicitation 逐次确认。** 由 feature `2026-08-28-command-risk-gated-confirmation` 一次性实施（breaking，v4.0.0）：

1. **拆除**：`MCP_CONFIRMATION_MODE`（含 `auto` 值，其行为与 `elicitation` 逐分支相同）、`MCP_ALLOWED_ROOTS`、`delete_preview` 工具、`src/headless-policy.ts`、`src/workspace-delete.ts` 及全部引用。旧配置残留值变为惰性死配置。
2. **新增**：`MCP_COMMAND_CONFIRMATION=risk-gated`——ordinary 命令免确认，heavy（批量>5 / 破坏残余 / 性能词表 / watch 长时长）经 Elicitation 说明原因请求权限；默认 `all` 保持现状。
3. **决策序定稿**：strict →（risk-gated：ordinary 放行 / heavy 确认）→ off → normal。
4. **保留不动**：hardBlock 不可关闭底线（DEC-001）、`DANGEROUS_PATTERNS` 命令策略、security.ts 硬底线、错误码表、非 allow 决策的 `safety.decision` 审计。

## 为什么选这个

- **与官方方向一致**：目录白名单是被废弃的路线，逐次确认 + 按需提权是官方推崇的模型；risk-gated 的 ordinary/heavy 两级正是 step-up 思想在命令面的落地。
- **误配即全锁是结构性缺陷**：headless 面与"用 off 跑项目命令"的常规用法冲突，且两个环境变量组合的语义不可预期（实证拦截 echo）；与其修补优先级矩阵，不如删除该面。
- **未选"保留 headless 但放宽"**：放宽后的 headless 等价于 off+审计，失去独立存在价值；目录授权需求官方已判定归宿主沙箱，server 侧重做即重新发明已废弃的 Roots。
- **未选"risk-gated 设为默认"**：属安全核心默认变更（D1=B），需更强授权与迁移说明，另立决定。

## 影响

- **破坏性（v4.0.0）**：删除公开工具 `delete_preview`（工具数 28→27）、删除两个环境变量、`delete_path` schema 移除 `preview_id`、`health://status` 移除 `confirmation_mode`/`headless_surface` 字段；CHANGELOG 记录迁移说明。
- **推荐配置**：个人本机 agent 场景用 `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`——简单命令流畅执行，重命令仍有一次带原因的确认。
- **未来约束**：不得重新引入 server 侧目录白名单授权面；如需无人值守删除能力，走宿主沙箱/客户端授权路线。heavy 规则表改动必须过入库语料（对齐 roadmap "禁止开放式补正则"纪律）。
- **遗留边界（不在本 feature 处理）**：explore-safe-block-diagnosis 记录的正则文本级误拦（`echo iex` 命中 hardBlock、`npm run start-process` 命中 dangerous）属 DEC-001"已知边界"，如需治理另立 issue 并逐 issue 授权。

## 关联文档

- [feature design](../features/2026-08-28-command-risk-gated-confirmation/command-risk-gated-confirmation-design.md) — 实施契约与验收场景
- [explore-safe-block-diagnosis](2026-08-28-explore-safe-block-diagnosis.md) — 拦截实证与分层定位
- [DEC-001 hardBlock 基线](2026-07-11-decision-hardblock-uncloseable-baseline.md) — 保留不动的灾难底线
- [command-execution-not-sandbox](2026-07-12-decision-command-execution-not-sandbox.md) — 形式化执行隔离边界（本决定不改变该口径：risk-gated 是 UX/降噪闸，非安全边界；误判为 ordinary 的命令在 risk-gated 下免确认执行，文档须如实说明）
