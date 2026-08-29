---
doc_type: feature-design
feature: 2026-08-29-docs-and-architecture-closeout
status: approved
created: 2026-08-29
last_reviewed: 2026-08-29
requirement: DOC-01
tags: [docs, changelog, usage-guide, security-policy, closeout]
summary: production-hardening #13——以最终代码、package manifest、profile matrix 和 gate 证据统一 v4.0.0/27/26 现状口径；清理 CHANGELOG 矛盾段、usage-guide 过期块、旧 roadmap 指引，新建 SECURITY.md 维护入口
---

# Design · docs-and-architecture-closeout（production-hardening #13）

## 1. 背景与目标

roadmap #13 交付原文（`production-hardening-roadmap.md` §6.13）：

> 统一 v4.0.0/27/26 tools、双 bootstrap、profile/capability、sandbox boundary、CHANGELOG、usage-guide、AGENTS、architecture、SECURITY/依赖维护入口和 acceptance/roadmap 状态。

验收标准（roadmap §6.13 + 审计 DOC-01）：用户文档、架构文档、工具 surface、health/prompt 和 package manifest 不再互相矛盾；active 文档检索无过期 headless 现状；现状文档、README、CHANGELOG、package 一致；实际落地内容回写现状档案。

**唯一目标是一致性，零行为改动。** 本 feature 不改任何运行时代码语义（唯一 `src/` 触点是 usage-guide prompt 文本），不 bump 版本号，不新增运行时依赖。

## 2. 现状残留清单（探索证据，grep 实证）

以下为 HEAD `e53808f` 时的实测残留，全部为本 feature 的输入：

| # | 位置 | 现状 | 问题 |
|---|---|---|---|
| R1 | `src/tools/utility.ts:556` | usage-guide prompt 的 `NEW in v3.1:` 块（9 条要点） | 客户端可见的活跃 prompt；标题过期，缺 v4.0 关键事实（risk-gated、profile、partial-result、输出预算、truthful health） |
| R2 | `CHANGELOG.md:85`（[4.0.0] Added 末行） | "Workspace-delete headless surface: delete_preview …" | 与同段 Breaking Changes（v4.0.0 拆除 headless）直接矛盾 |
| R3 | `CHANGELOG.md:93`（[4.0.0] Changed） | "Tool surface is now 28 tools by default (27 when …)" | 与同段 Breaking Changes "27 tools" 矛盾 |
| R4 | `CHANGELOG.md:97-100`（[4.0.0] Fixed） | 4 条 headless enforcement 修复条目 | 描述 4.0.0 已删除的 surface，对 4.0.0 读者误导 |
| R5 | `CHANGELOG.md:79`（[4.0.0] Added） | `ENHANCED_TERMINAL_DISABLE_FILE_INFO` 括注 "27 tools when set after the workspace-delete tool was added" | 4.0.0 现状是 27 默认 / 26 when set；括注是 3.x 口径 |
| R6 | `CHANGELOG.md:35-36`（[Unreleased] Changed） | 旧 CI workflow + 旧 `pnpm run gate` 描述 | 已被 #12 canonical gate 条目（同段 Added 12-13 行）取代且语义冲突（旧 gate 六阶段 vs canonical gate 九阶段 release blocking） |
| R7 | `CHANGELOG.md` [Unreleased] | 三个 `### Added` + 三个 `### Changed` 重复小节 | 违反 Keep a Changelog 1.1.0 单组结构（文件头声明遵循） |
| R8 | `tests/e2e-latency.test.ts:2` | 文件头 `Enhanced Terminal MCP v3.1.0` | 版本号过期 |
| R9 | `README.md:267` | "remaining work in `codestable/roadmap/2026-07-12-remaining-hardening/`" | 该 roadmap 15 条全 done/dropped（closed），指引过期 |
| R10 | `AGENTS.md:100` | 同上（"剩余 hardening / 产品边界规划：2026-07-12-remaining-hardening"） | 同上 |
| R11 | `ARCHITECTURE.md` §7 规划入口 + 头部核对行 | 旧 roadmap 两条未标 closed；最后核对行止于 #12 | #13 后两份 roadmap 均闭环，规划入口需终态 |
| R12 | 项目根 | 无 `SECURITY.md` | SUPPLY-01 审计指出的"漏洞披露入口"缺位；GitHub Security tab 无可展示政策 |

**保留不动的语义性 v3.1 引用（准确，不改）**：`src/shell.ts:299`、`tests/unit/shell.test.ts:322`、`tests/unit/upgrades-r2.test.ts:17`（"cmd 兼容档回退 v3.1 的 powershell.exe 行为"——精确描述兼容档语义）；`ARCHITECTURE.md:156` ADR-7 同类语义引用；`ARCHITECTURE.md:16` 创建行（历史事实，最后核对行已单独存在）；CHANGELOG [3.1.0]/[3.0.0] 历史版本段；`codestable/features/2026-08-23-harness-headless-safety/` 历史档案（记录当时已完成的事实，取代关系由 DEC-002 与 Breaking Changes 叙述）。

## 3. 交付物

### D1 CHANGELOG 收口

1. [4.0.0] 段删除 R2/R3/R4 三组 headless 矛盾条目（生命周期已由 Breaking Changes 首条完整叙述，理由见 DEC-A）；修正 R5 括注为 "27 tools by default, 26 when set"。
2. [Unreleased] 段：合并三个 Added / 三个 Changed 为单组（R7）；删除被 canonical gate 条目取代的旧 CI/gate 两条（R6，tools-coverage 门禁与盲单测条目保留）；补 #13 收口条目（文档统一、SECURITY.md、usage-guide 更新）。
3. 其余历史条目（含 [3.1.0]/[3.0.0]、[4.0.0] 其余 Added）原样保留。

### D2 usage-guide prompt 更新（`src/tools/utility.ts`）

- 标题 `NEW in v3.1:` → `NEW in v4.0:`；保留仍准确的既有要点（telemetry_report、temp_stats、paging、audit、session_state、cache、结构化输出、错误码、safety mode）；补充 v4.0 关键事实：`MCP_COMMAND_CONFIRMATION=all|risk-gated` 分级确认、执行 profile（`local-trusted-shell` 默认 / `sandboxed-production` capability）、search/list partial-result contract（`complete`/`warnings`）、`MCP_RESPONSE_MAX_BYTES` 输出预算、truthful `health://status`。
- **契约不变**：首行 `Enhanced Terminal MCP v${VERSION} provides ${getRegisteredToolCount()} tools` 保持动态（`tests/tool-visibility.test.ts` 的计数一致性断言依赖它；conformance 套件仅断言 prompts 名称与可获取性）。

### D3 旧 roadmap 指引与架构收口

- `README.md:267`：改为指向 `SECURITY.md`（安全政策入口）+ `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md`（保留）；删除过期 "remaining work" 指引。
- `AGENTS.md:100`：改为"hardening 规划已闭环"口径——旧 remaining-hardening（closed）与 production-hardening（13/13，2026-08-29）保留为历史；新工作按 `STATUS.md` 下一步开工。
- `ARCHITECTURE.md`：§7 规划入口给两份 roadmap 补 closed 标注并加 production-hardening 完成行；头部"最后核对"行更新到 #13；变更日志加 #13 条目。

### D4 SECURITY.md（新建，项目根）

只写已落地现实，逐条可追溯：

- 威胁模型边界：defense in depth, not a sandbox（引用 `2026-07-12-decision-command-execution-not-sandbox.md`）；hardBlock 全模式不可关闭底线（引用 DEC hardblock-baseline）；headless/Roots 拆除的官方 MCP 对齐口径（引用 DEC-002）。
- profile 边界：`local-trusted-shell`（默认，信任本机用户）与 `sandboxed-production`（要求宿主提供隔离 worker/身份 scope/egress，缺失即 fail-closed unsupported，本仓库不内置沙箱后端）。
- 依赖维护政策：SDK 精确锁 1.29.0 + fail-closed postinstall patch、`pnpm audit --prod --audit-level=high` release 阻断、zod v3 决策引用。
- 报告渠道：GitHub private security advisory（首选）/ Issues。
- **明确不做**：`dependabot.yml`、`CODEOWNERS`（引入 bot/CI 行为变更，超出文档统一范畴，需要时另立 feature）。
- README Supply chain 段加一行指向 `SECURITY.md`。

### D5 测试头注释

`tests/e2e-latency.test.ts:2` 版本号 → v4.0.0。

### D6 验证

1. `pnpm run gate` 全量（唯一完整门禁，覆盖 conformance/tool-visibility 对 prompt 的既有断言）。
2. 复扫 grep：`NEW in v3.1` 全库 0 命中；CHANGELOG [4.0.0] 段无 headless Added/Changed/Fixed 条目；全库（md/ts，排除历史版本段与白名单文件）无过期 "28 tools" 现状叙述。
3. `search-yaml` active 检索复核（headless 相关 active 命中仅为"已拆除"叙述、DEC-002、审计与历史档案）。
4. `validate-yaml.py` 覆盖本 feature checklist 与回写触发的 YAML。

### D7 现状档案回写

`production-hardening-items.yaml` #13 → done + feature 绑定 + notes；`production-hardening-roadmap.md` §6.13 验收回写 + 问题—feature—证据矩阵 DOC-01 行更新 + §9 观察项第 1 条（AGENTS/ARCHITECTURE 过期文字）标记解决；audit explore §6 补 #13 收口行、§7 推荐顺序给 13/13 终态；`STATUS.md` 13/13 + HEAD + 下一步；本 design/checklist/acceptance 三件套。

## 4. 关键决策

- **DEC-A（[4.0.0] headless 条目删除而非改写）**：同段并存 "Added: headless surface" 与 "Breaking: removed" 自相矛盾；生命周期已由 Breaking 首条 + DEC-002 完整叙述，npm 4.0.0 消费者视角无需阅读已删除面的修复历史。历史经 git blame / DEC-002 / harness-headless-safety 档案可回溯。
- **DEC-B（usage-guide 保留版本要点块约定）**：沿用 "NEW in vX.Y:" 既有格式并随本 feature 更新到 v4.0；不引入自动生成机制（复杂度不成比例）。
- **DEC-C（SECURITY.md 只陈述现状）**：威胁模型、依赖政策、报告渠道全部锚定既有实现与决策文档；不承诺 roadmap 计划中的能力（roadmap §220 不做条款）。
- **DEC-D（不 bump 版本）**：收口改动归入 [Unreleased]；是否发版是产品决策，留给用户。
- **DEC-E（lint 9 warnings 不顺手清）**：属代码清理，与文档收口正交，逐 issue 处理（#12 acceptance §9 已记录）。

## 5. 明确不做

- 不修改 [3.1.0]/[3.0.0] 历史版本段与 [4.0.0] 其余条目。
- 不改 §2 白名单中的语义性 "v3.1 行为" 引用与历史档案（harness-headless-safety frontmatter 不加注记——档案记录当时事实，取代关系已有权威叙述）。
- 不新建 `dependabot.yml` / `CODEOWNERS`。
- 不 bump 版本号、不发版。
- 不改任何运行时行为、工具数硬编码口径（继续 `getRegisteredToolCount()` 动态）、安全规则、错误码。
- 不清理 lint 既有 9 warnings。
- 不改 `codestable/requirements/`（无 production-hardening 对应 requirement 文档；三个既有 requirement 与本 feature 无关）。

## 6. 验收场景

| 场景 | 证据 |
|---|---|
| 全量门禁绿 | `pnpm run gate` EXIT=0（含 conformance / tool-visibility / hostile-input / platform smoke） |
| 活跃 prompt 无过期版本块 | grep `NEW in v3.1` = 0 命中；usage-guide 含 v4.0 要点且首行计数契约不变 |
| CHANGELOG 自洽 | [4.0.0] 段无 headless Added/Changed/Fixed 残条目；[Unreleased] 单组 Added/Changed/Fixed；全文无 "28 tools by default" 现状叙述 |
| 指引无过期 roadmap | README/AGENTS/ARCHITECTURE 不再把 remaining-hardening 当"剩余工作"入口；production-hardening 标注 13/13 |
| 维护入口存在 | 根目录 `SECURITY.md` 内容逐条可追溯至既有实现/决策；README 链接可达 |
| 检索卫生 | `search-yaml` active 检索无过期 headless 现状命中 |
| YAML 健康 | validate-yaml 全过 |

## 7. 多轮审计记录

- **Round 1（残留清单定稿）**：全库 grep（md/ts）+ 归档检索定位 R1–R12；发现 R6（[Unreleased] 旧 CI 条目与 #12 canonical gate 冲突）为清单外新问题，纳入。
- **Round 2（决策复核）**：核对 DEC-A…E 与既有 decision 无冲突（DEC-002/hardblock/not-sandbox 均为引用而非改写）；确认 requirements 无需回写；确认 conformance/tool-visibility 测试对 usage-guide 的断言面（名称、可获取性、首行动态计数），D2 安全。
- **Round 3（终审）**：白名单边界（shell.ts 等 4 处语义引用 + 历史版本段 + harness 档案）逐条核对为"准确叙述当前兼容语义/历史事实"，不构成过期现状；版本号、发版、dependabot 边界重申；无新问题 → 定稿（approved）。
