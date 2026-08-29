---
doc_type: feature-acceptance
feature: 2026-08-29-docs-and-architecture-closeout
status: done
created: 2026-08-29
summary: 对照 design 完成 production-hardening #13 文档收口——CHANGELOG 矛盾段清理与 [Unreleased] 单组化、usage-guide v4.0、SECURITY.md 新建、三份权威文档闭环口径、paging 测试高负载 ENOTEMPTY 竞态修复，release gate 11 阶段全绿，roadmap 13/13 闭环
tags: [docs, changelog, usage-guide, security-policy, closeout, acceptance]
---

# Acceptance · docs-and-architecture-closeout（production-hardening #13）

## 1. 接口契约核对

### 名词层与挂载接口逐项核对

- [x] **零运行时行为改动**：`src/` 唯一触点是 `src/tools/utility.ts` 的 `usage-guide` prompt 文本（D2）；工具注册面、输入输出契约、错误码、安全规则零改动；`git diff src/` 仅该文件。
- [x] **usage-guide 首行动态计数契约保持**：`Enhanced Terminal MCP v${VERSION} provides ${getRegisteredToolCount()} tools ...` 原样保留；`tests/tool-visibility.test.ts`（prompt 文本计数一致）与 `tests/mcp-conformance.test.ts`（prompts list/get）随 release gate 通过。
- [x] **工具数继续动态获取**：无新增硬编码工具数（AGENTS.md 禁止事项遵守）。
- [x] **SECURITY.md 只陈述已落地现实**：威胁模型（defense in depth not a sandbox → `2026-07-12-decision-command-execution-not-sandbox.md`）、hardBlock 不可关闭（→ `2026-07-11-decision-hardblock-uncloseable-baseline.md`）、headless 拆除口径（→ DEC-002）、profile 边界（sandboxed-production 需宿主隔离，缺即 fail-closed）、依赖政策（SDK 1.29.0 精确锁 + fail-closed patch + `pnpm audit --prod --audit-level=high` 阻断 + zod v3 决策）——逐条可追溯到既有实现/决策文档；报告渠道 GitHub private security advisory（首选）/ Issues。
- [x] **不新建 dependabot.yml/CODEOWNERS、不 bump 版本号、不发版**：根目录无新增 CI/bot 配置；`package.json` version 仍为 `4.0.0`；收口改动归入 CHANGELOG [Unreleased]。

### 编排图核对

- [x] 交付面 D1–D7 与 design 一致：CHANGELOG 收口、usage-guide 更新、指引收口（README/AGENTS/ARCHITECTURE）、SECURITY.md、e2e 头注释、验证、现状档案回写。

## 2. 行为与决策核对

### 需求摘要逐项验证

- [x] **R1 usage-guide**：`NEW in v3.1:` → `NEW in v4.0:`；保留仍准确的 v3.1 要点；补 risk-gated、profile、partial-result、`MCP_RESPONSE_MAX_BYTES`、truthful `health://status` 五组 v4.0 事实。
- [x] **R2–R4 CHANGELOG [4.0.0] 矛盾条目**：headless Added 条目、"28 tools by default" Changed 条目、4 条 headless Fixed 条目全部删除；DEC-A 依据（Breaking Changes 首条已完整叙述生命周期）落实。
- [x] **R5**：`ENHANCED_TERMINAL_DISABLE_FILE_INFO` 括注改为 "27 tools by default, 26 when set"。
- [x] **R6**：[Unreleased] 中被 #12 canonical gate 取代的旧 CI workflow 与旧 `pnpm run gate` 两条删除；canonical-gate 条目补 CI 调用同一入口、固定 action SHA、`contents: read` 表述。
- [x] **R7**：[Unreleased] 三个 Added / 三个 Changed 合并为单组 `### Added`（15 条）+ 单组 `### Changed`（15 条），符合 Keep a Changelog 单组结构；`prepack`/`tsx` 两条 "Added ..." 文案归位 Added 组。
- [x] **R8**：`tests/e2e-latency.test.ts:2` 头注释 → v4.0.0。
- [x] **R9/R10**：README Supply chain 段与 AGENTS.md 已知坑行的 remaining-hardening 指引改为闭环口径（指向 `SECURITY.md` / `STATUS.md`，标注两份 roadmap closed）。
- [x] **R11**：ARCHITECTURE §7 规划入口给 merge-e（已完成）/ remaining-hardening（closed）/ production-hardening（closed：13/13，2026-08-29）终态标注；头部"最后核对"行与 frontmatter `last_reviewed` 更新；变更日志加 #13 条目。
- [x] **R12**：根 `SECURITY.md` 建立并接入 README。

### 关键决策落地

- [x] **DEC-A**：[4.0.0] headless 残条目删除而非改写（同段 Breaking 已叙述生命周期，git blame/DEC-002/harness 档案可回溯历史）。
- [x] **DEC-B**：usage-guide 保留 "NEW in vX.Y:" 版本要点块约定，随本 feature 更新至 v4.0。
- [x] **DEC-C**：SECURITY.md 零新承诺，全部锚定既有实现与决策文档。
- [x] **DEC-D**：不 bump 版本，发版决策留用户。
- [x] **DEC-E**：lint 既有 9 warnings 未顺手清（与本 feature 无关）。

### 跨层纪律核对

- [x] **白名单保留**：`src/shell.ts:299`、`tests/unit/shell.test.ts:322`、`tests/unit/upgrades-r2.test.ts:17`、ARCHITECTURE ADR-7 的"cmd 兼容档回退 v3.1 的 powershell.exe 行为"语义引用零改动（准确描述兼容语义）；CHANGELOG [3.1.0]/[3.0.0] 历史段与 [4.0.0] 其余条目零改动；`codestable/features/2026-08-23-harness-headless-safety/` 历史档案零改动。
- [x] **范围外零触碰**：`codestable/requirements/` 未改（无 production-hardening 对应 requirement 文档）；lint warnings 未清；未引入运行时依赖。

## 3. 验收场景核对

### 3.1 文档一致性证据

- [x] `NEW in v3.1` 全库（md/ts，排除 node_modules/build）**0 命中**。
- [x] `28 tools by default` 仅剩 2 处命中且均在**本 feature design 文档**内（引用问题原文与验收标准，自引用非现状叙述）。
- [x] CHANGELOG [4.0.0] 段 headless 仅存 Breaking Changes 两处合法"拆除"叙述（`grep -i headless` = 2，均在 Removed 条目内）；[Unreleased] 单组 Added/Changed 结构确认。
- [x] `remaining-hardening` 在 README/AGENTS/ARCHITECTURE 中仅以 closed/闭环口径出现（grep 复核）。
- [x] `search-yaml` active 检索复核：headless 命中仅为 ARCHITECTURE（"已拆除"正确叙述）、DEC-002（拆除决策）、审计 explore（现状审计）、安全诊断 explore（已 outdated）与 harness-headless-safety 历史档案（记录当时事实），无把 headless 当现状的 active 命中。
- [x] `validate-yaml.py`：本 feature checklist 与 design 校验通过；回写触发的 items.yaml 经 YAML 解析（gate package-verifier 阶段亦通过）。

### 3.2 canonical gate 证据

- [x] 第 1/2 次全量 gate 在 full test 阶段各挂 1 个 paging 测试用例（分别为 `strips UTF-8 BOM from paged content` / `recovers a v2 cache after a new PageCache instance`，同为 `ENOTEMPTY: directory not empty, rmdir ...temp`；定向复跑 paging 5/5 全绿）——确认为**高负载下 afterEach `fs.rm` 与 100ms TTL 异步 sweep/spill 的竞态**，与本次纯文档改动无关（src 唯一触点为 prompt 文本），属 #12 验收记录的 Windows rename/句柄时序 flake 同族。
- [x] **修复**：`tests/unit/paging.test.ts` afterEach 的 `fs.rm` 增加 `{ maxRetries: 10, retryDelay: 100 }` 有界重试（Node fs.rm 对 ENOTEMPTY/EBUSY/EPERM 线性退避；重试耗尽仍抛真实错误，不吞错、不无限重试、不扩大 timeout——符合 #12 稳定性节点纪律）。修复后定向 5/5 全绿。该修复超出 design D1–D5 清单，属 D6 gate 证据的前置 test-infra 修复，在此显式记录为设计偏离；test-only，零运行时行为改动。
- [x] 第 3 次 release gate **11 阶段全部 passed**（mode=release，报告 `.etmcp/gate-report.json`）：build 3.2s / typecheck 2.2s / lint 0.7s / **test 16.7s（69 文件 845 用例，前两次运行日志实测 844+1=845，本 run 同套件）** / coverage-main 17.6s / coverage-tools 6.7s（阈值达标）/ latency 7.9s（stage 通过；前两次运行实测 24/24 within threshold）/ dependency-audit 1.7s / package-verifier 2.3s / pack-consumer 1.4s（enhanced-terminal-mcp-4.0.0.tgz）/ clean-consumer 17.7s（package-owned SDK 1.29.0 + consumer SDK 1.30.0）。
- [x] `git diff --check` 干净。

### 3.3 明确不做的反向核对

- [x] 未修改 [3.1.0]/[3.0.0] 历史段与 [4.0.0] 其余条目（diff 逐行核对：[4.0.0] 段仅删除 3 组 headless 条目 + 1 处括注修正）。
- [x] 未新建 dependabot.yml/CODEOWNERS；未 bump 版本；未清 lint warnings；未改 `codestable/requirements/`；harness-headless-safety 档案 frontmatter 未加注记（design 明确不做）。
- [x] 未触碰安全核心（DANGEROUS_PATTERNS/HARD_BLOCK_PATTERNS/hardBlock/safeguard 模式逻辑/错误码兼容表）。

## 4. 术语一致性

- 27/26 tools（默认/disabled）、`MCP_COMMAND_CONFIRMATION=all|risk-gated`、`local-trusted-shell`/`sandboxed-production`、hardBlock 不可关闭、canonical gate、partial-result contract、truthful health——全文档口径一致；"28 tools" 仅存于历史版本段（无）与白名单语义引用（无）。

## 5. 架构归并

- 无新增模块、无 ADR 变化；ARCHITECTURE 变更日志补 #13 收口条目，§7 规划入口改为闭环终态。

## 6. requirement 回写

- 无对应 requirement 文档（`codestable/requirements/` 三份与本 feature 无关）；审计 DOC-01 行已在 roadmap §8.6 矩阵更新为已完成。

## 7. roadmap 回写

- [x] `production-hardening-items.yaml`：`docs-and-architecture-closeout` → `done`，绑定 `2026-08-29-docs-and-architecture-closeout`，notes 完整记录交付面与边界。
- [x] `production-hardening-roadmap.md`：§6.13 验收回写；§8.6 矩阵 DOC-01 行更新为已完成、引导语改为 13/13 闭环；§9 观察项第 1 条标记解决；§10 变更日志补 #13 条目并宣告 roadmap 全部完成。
- [x] audit explore：新增 §6.13 实施状态；§7 推荐修复顺序第 1/5 条收口；"后续建议"改为 13/13 闭环与后续开工口径。
- [x] `STATUS.md`：13/13 done、HEAD、回归指标、下一步更新。

## 8. AGENTS.md / CLAUDE.md 候选盘点

- 无新增候选；本 feature 的"文档收口以 grep 复扫 + search-yaml 检索卫生为验收证据"做法已由 design/acceptance 固化，暂不上升为 AGENTS 硬规则。

## 9. 遗留

- paging 测试修复属 test-infra 最小修复；其他测试文件的裸 `fs.rm` 清理未批量改写（未观察到 flake，避免超范围），后续如在高负载再现可按同款有界重试逐文件处理。
- lint 既有 9 warnings（`src/temp-manager.ts` 未用 `id`、`tests/unit/network-policy.test.ts` 未用 `req` 等）维持 #12 acceptance 记录，待逐 issue 清理。
- 发版（4.0.x tag / npm publish）、dependabot/CODEOWNERS、CI provenance 属用户产品决策，本 feature 明确不做。
- Linux/macOS 与 Node 20/22 的 platform matrix 结果仍以 CI runner 为外部证据边界（与 #12 相同，未变）。
