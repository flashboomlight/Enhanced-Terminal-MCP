---
doc_type: feature-acceptance
feature: 2026-08-19-merge-e-hardening-base
status: confirmed
summary: M1 merge 验收：接口契约、行为决策、场景证据全绿；shell.test.ts 归位偏差已当场修复；文档差异清单留作 M4 输入
tags: [merge, hardening, acceptance, shell, state-dir]
created: "2026-08-19"
---

# merge-e-hardening-base 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-19
> 关联方案 doc：codestable/features/2026-08-19-merge-e-hardening-base/merge-e-hardening-base-design.md
> 验收对象：merge commit `3f6d477`（双亲 `dee6771` + `e28f2e9`）+ docs commit `d90f84e`

## 1. 接口契约核对

本 feature 的"接口"是 roadmap 4.2 裁决矩阵规定的各文件组合形态，逐项核查（证据 = HEAD 上 grep/读取）：

**矩阵逐项核对**：

- [x] `src/tools/command.ts` = D 的 `getShellSpec()`/`buildShellInvocation()` + E 的 precheck/audit/rateLimit/session → 一致（`command.ts:16` import D shell；`:8-15` import E 的 audit/policy/session；`:22` policy 前置，`:161-162` shell resolution 与 invocation）
- [x] `src/security.ts` = D PowerShell 注入防护与 E 间接执行/解释器/管道绕过并集 → 一致（D：`-EncodedCommand` 及前缀缩写 `security.ts:280`、`Invoke-Expression|iex :347`；E：解释器 `:294`、内联 system `:342-343`）
- [x] `src/command-policy.ts` 保留 E blocklist/allow、统一入口、audit 分类；hardBlock 永远先执行 → 一致（`command-policy.ts:110` `hardBlock(cmd)` 先行，头注 `:5` "1) 始终先 hardBlock"）
- [x] `src/result.ts` 保留 E 统一错误体系；`isError:true` 时 structuredContent 不再丢 detail → 一致（新增 `structuredErrorSchema` + `withErrorSchema()`；错误路径返回 `{ ok:false, error }` 含 detail；落地形态按 SDK 1.29 单一 object 约束，见 design 执行期调整记录 2 与 compound learning）
- [x] `src/pool.ts` / `pool_stats` 采用 E inactive stub → 一致（`pool.ts:36` 固定返回 `active:false`；探针 A2 实测）
- [x] `file_info` 保留 D 的 `ENHANCED_TERMINAL_DISABLE_FILE_INFO` 开关 → 一致（探针 B1：设置后 26 个工具）
- [x] package/lock 采用 E 依赖基线；tests 采用 E 的 `tests/unit/` 结构并补 D shell、file_info 契约 → 一致（`package.json`：engines `>=20.0.0`、SDK 精确 `1.29.0` + overrides、zod `^3.25.67`、零依赖 postinstall、patch-package 仅 dev；`tests/unit/` 29 个文件 + `tests/tool-visibility.test.ts` 覆盖 file_info 契约）

**名词层"现状 → 变化"逐项核对**：

- [x] 合并后名词集合 = E 全量模块 + D `shell.ts` + D `file_info` 开关 → 一致（全部文件在案）
- [x] `package.json` `files` 仍含 `es_tool/es.exe`（M3 再移除）→ 一致（`package.json:12`）
- [x] 状态名词统一为 `<projectRoot>/.etmcp` → 一致（`state-dir.ts`；`.gitignore:52`）
- [x] D 内联测试迁移到 `tests/unit/` → **验收中发现偏差并当场修复**：`src/shell.test.ts`（D shell 契约测试，25 例）漏迁，仍留在 src 侧。已 `git mv` 至 `tests/unit/shell.test.ts`，import 改为 `../../src/` 约定；全量测试复跑 34 文件 / 455 用例与迁移前持平，biome 通过。修复后 `src/*.test.ts` glob 为空，矩阵"tests 采用 E 的 tests/unit/ 结构"真正成立。

**流程图核对**（design 2.2 mermaid，merge 过程编排）：

- [x] 阶段 A preflight → ref 事务 → merge → 矩阵裁决 → 阶段 B 门禁 → 专项验证 → 用户确认后 commit，全部按序执行并留痕（checklist steps 全 done；merge commit `3f6d477` 经用户确认后提交）

## 2. 行为与决策核对

**需求摘要逐项验证**（design 1.1 成功标准 = roadmap 5.1）：

- [x] 双历史可见：`git log --graph` 显示 `3f6d477` 双祖先 `dee6771`/`e28f2e9` ✓
- [x] pwsh 契约执行真实命令：探针 A3 `echo 中文验收` 原样返回，无乱码 ✓
- [x] hardBlock、policy、audit、rate limit、session 生效：探针 D1/E1/E2/A5 + 单测 `security*.test.ts`、`command-policy.test.ts`、`ratelimit.test.ts`、`session.test.ts`、`audit.test.ts` ✓
- [x] `pool_stats.active=false`：探针 A2 ✓
- [x] tool count 27/26：探针 A1/B1 ✓
- [x] Node/SDK/zod/postinstall 基线固定：`package.json` 实测 ✓
- [x] 冲突裁决有记录、门禁全绿：design 执行期调整记录 + 本报告第 3 节 ✓

**明确不做逐项核对**（design 1.1 / 3.3）：

- [x] 无 rebase/squash/cherry-pick：`git log --oneline d430224..HEAD` 可见完整双历史 + merge commit ✓
- [x] 无 remote/push/PR：`git remote -v` 为空 ✓
- [x] `.serena/` 未进任何 commit：`git ls-files | grep -ci serena` = 0 ✓；未执行 `git clean` ✓；E 仓库未删除/移动/重命名 ✓
- [x] 未实现 M2/M3 内容：src 无 `CommandOutputEnvelope`/A+ 新 cache 格式（`paging.ts` 保持 E 基线）；`es.exe` 发布边界未动 ✓
- [x] zod 未升 v4 ✓；ProcessPool 未激活 ✓
- [x] 未额外触发真实迁移：迁移协议仅由 `tests/unit/state-migration.test.ts` 15 例覆盖；探针产生的 `.etmcp` 残留已清理 ✓
- [x] README/AGENTS/ARCHITECTURE 未提前改写（归 M4，差异见第 5 节）✓

**关键决策落地**（design 1.3）：

- [x] `--no-ff --no-commit` + 人工裁决后统一 commit → merge commit 形态与确认流程均符合
- [x] 冲突严格按矩阵裁决；执行期发现（E 未携带 4.5、SDK 1.29 约束、grep_content 行级契约）按"停下报告"精神处理：记录于 design 执行期调整记录 2，merge commit 提交前已向用户完整报告并经确认
- [x] backup 锚点 `dee6771` → `git rev-parse backup/pre-merge-20260819` 一致
- [x] 测试结构 E 布局 → 含验收修复的 shell.test.ts 归位
- [x] pool inactive stub → `pool.ts:36` + 探针 A2

**编排层核对**：

- [x] 命令执行链顺序 input validation → checkCommandPolicy → hardBlock/blocklist/allow → rate limit → SafeGuard → shell resolution → spawn → output capture → audit/structured result：`command.ts:22` policy 先于 `:161` shell resolution；探针 C1 中 SafeGuard 关闭后 shell 错误才暴露，佐证顺序 ✓

**跨层纪律核对**：

- [x] 错误语义保持 D 现状：`shellResolutionFail`（`shell.ts:318`）将 `INVALID_SHELL_MODE`/`SHELL_PATH_INVALID`/`SHELL_NOT_FOUND` 包装为 `EXECUTION_FAILED` + `[code]` 消息前缀 + detail.attempted；探针 C1 实测 `[INVALID_SHELL_MODE]` ✓
- [x] 幂等：backup/integration ref 建立前核对指向，已存在且正确即复用（T04 留痕）✓
- [x] 并发/顺序：Git 操作全程串行，merge 存续期间无其他写操作 ✓
- [x] 可观测：各阶段门禁输出留痕；裁决记录于 design 调整记录 ✓
- [x] 安全性并集：见第 1 节 security.ts 证据；hardBlock 三模式不可关闭（探针 D1 off 模式仍拦截；strict/normal 由 `security-corpus.test.ts` 等覆盖）✓

**挂载点核对**（design 2.3）：

- [x] 5 项挂载点全部有代码落点：Git refs（在案）、package.json 基线（在案）、`shell.ts` 与 E 模块共存（在案）、`tests/unit/` 布局（在案）、`.gitignore` `.etmcp/`+`.enhanced-terminal-mcp/`（`.gitignore:51-52`）
- [x] 反向 grep：`backup/pre-merge-20260819`/`integration/e-main` 仅出现于 3 个 codestable 文档（design/checklist/roadmap），无清单外引用；`ensureStateMigration` 仅挂载于 `state-dir.ts`（定义）/`session.ts`/`audit.ts` + 测试，与清单一致
- [x] 拔除沙盘推演：回滚路径 = roadmap 4.1 第 2 条（`git reset --hard backup/pre-merge-20260819`，需用户再次确认）；推演残留 = 两个 Git refs（验收后按 T12 处置，属预期挂载点）+ `.etmcp` 运行时目录（gitignored，探针残留已清），无其它残留

## 3. 验收场景核对

证据分两轮：merge 后 HEAD 上全量复跑（2026-08-19 18:49）+ shell.test.ts 修复后复跑（18:58），均全绿。

- [x] **S1** 阶段 A preflight（三 SHA / Node>=20 / 非 C 盘 TEMP·TMP·npm cache / E 工作树干净）→ 证据：T03 preflight 留痕；结果：通过
- [x] **S2** ref 事务（backup=`dee6771`、integration=`e28f2e9`、merge-base=`d430224`、`.serena/` 未进 staged）→ 证据：T04 核对记录 + `git status` 长期仅 `?? .serena/`；结果：通过
- [x] **S3** 阶段 B 门禁全绿：`npm install` ✓ / `npm run build` ✓ / `npx tsc --noEmit` ✓ / `npm run lint`（biome 68 文件）✓ / `npm test` **34 文件 455 用例** ✓ / `npm run test:latency` **24/24** ✓ / `git diff --check` ✓ → 证据：两轮复跑输出；结果：通过
- [x] **S4** `pool_stats.active=false` + 27/26 工具 → 证据：探针 A1/A2/B1（真实 stdio JSON-RPC）；结果：通过
- [x] **S5** 默认 pwsh 真实执行、中文无乱码 → 证据：探针 A3 输出"中文验收"原样返回；结果：通过
- [x] **S6** hardBlock 三模式拦截 → 证据：探针 D1（off 模式 `-EncodedCommand` 仍 `COMMAND_DANGEROUS`）+ `security-corpus.test.ts`/`security.test.ts`（strict/normal）；结果：通过
- [x] **S7** allow policy 拒绝拼接/管道/嵌套、batch 全量预检 → 证据：探针 E1（白名单内放行）/E2（`&&` 拒绝）+ `command-policy.test.ts`（batch 预检）；结果：通过
- [x] **S8** `MCP_BATCH_RATE_MODE=batch|per_command` 双模式 → 证据：`ratelimit.test.ts`；结果：通过
- [x] **S9** state root 不随 session cwd 漂移 → 证据：探针 A4（`set_cwd` 后 `session.json` 仍落 repo `.etmcp`，目标侧无漂移文件）；结果：通过
- [x] **S10** 矩阵未覆盖冲突停报机制 → 实际情况：冲突全部映射矩阵行，未出现矩阵外冲突；2 项执行期前提偏差（E 未携带 4.5、SDK 1.29 约束）按停报精神记录并经用户知情确认；结果：通过
- [x] 前端验证：本项目无前端 UI（AGENTS.md 约定验证集 = build/tsc/lint/test/latency，已全部执行），豁免浏览器验证

探针细节：`MCP_SAFETY_MODE=off` 用于 shell/policy 层探针（与 `tests/e2e-latency.test.ts`、`tests/tool-visibility.test.ts` 的 headless 约定一致）；normal 模式的 SafeGuard 确认链路由 `tests/safeguard.test.ts` 覆盖。

## 4. 术语一致性

- `withErrorSchema` / `structuredErrorSchema`：代码 35 处命中（`result.ts` 定义 1 + 7 个工具文件 import 7 + 27 个工具注册包裹 27），命名全一致 ✓
- `ensureStateMigration` / `runStateMigration` / `STATE_MIGRATION_FAILED` / `MCP_STATE_DIR`：20 处命中，跨 `state-dir.ts`/`session.ts`/`audit.ts` 一致 ✓
- `.etmcp`：活跃状态目录引用一致；`.enhanced-terminal-mcp` 仅 3 处 legacy 语义（`state-dir.ts:8` 注释、`:32` 常量、`:102` 全局 legacy 文件路径），无活跃误用 ✓
- shell 错误码：`INVALID_SHELL_MODE`/`SHELL_PATH_INVALID`/`SHELL_NOT_FOUND`（`shell.ts:39`）全库一致 ✓
- 防冲突：M2 名词（`CommandOutputEnvelope`、新 page-cache 格式）未泄漏进 src ✓

## 5. 架构归并

**按 design 第 4 节执行：本 feature 不回写 ARCHITECTURE.md / requirements/**（roadmap 第 8 节规定文档同步统一在 M4 按最终实现执行；"README/AGENTS/ARCHITECTURE 未提前改写"同时是 3.3 反向核对项，已验证成立）。

按 design 第 4 节要求，记录**当前文档与代码的已知差异点清单**，作为 M4 输入：

1. `codestable/architecture/ARCHITECTURE.md`：仍描述 Node 18、26 工具、活跃预热池、旧 session 路径（`.enhanced-terminal-mcp`/`%TEMP%`）→ 现状：Node `>=20.0.0`、27/26 工具、pool inactive stub、`<projectRoot>/.etmcp` + `MCP_STATE_DIR` + 4.5 迁移引擎（roadmap 第 9 节观察项已预告）
2. `AGENTS.md` 常用命令：测试基线仍写"35 文件 / 599 用例"→ 实际 **34 文件 / 455 用例**（E 测试基线取代 D）；其余 AGENTS 内容（27/26 工具、tests/unit、安全双层、hardBlock 底线）经 merge 已与现状一致
3. `README.md`：merge 带入 E 版本，`.etmcp`/`MCP_STATE_DIR`/迁移行为、27 工具、Node 20 基线等待 M4 按最终代码核对统一
4. E 旧 state/temp 相关 decision（compound 内）仍声称 `.enhanced-terminal-mcp` 为当前行为 → M4 更新或 supersede（roadmap 第 9 节）
5. E 旧分页 decision（"超过 pageSize 即落盘" + 整文件读取）→ 将由 M2 A+ supersede（roadmap 第 9 节）
6. `codestable/requirements/powershell-default-shell.md`：pwsh 解析链行为未变，M4 按"最终行为确有变化才更新"条款判断
7. `CHANGELOG.md`：E 版本合入，M4 统一口径（含 3.1.0 之后条目归属）

判据说明：本 feature 交付的是"可运行合并基线"，architecture 面向读者的完整描述由 M4 在 A+/es/文档收口后一次性写入；本条清单已保证差异不丢。

## 6. requirement 回写

方案 frontmatter `requirement: null`，且 design 第 4 节 + roadmap 第 8 节明确"最终实现完成前，不提前把计划写入 architecture 或 requirements"。

结论：**无 requirement 回写**（归 M4；M4 以第 5 节差异清单为输入判断 backfill/update）。

## 7. roadmap 回写

方案 frontmatter `roadmap: merge-e-hardening-into-d` / `roadmap_item: merge-e-hardening-base`，两字段有值，已执行实际回写：

- [x] `codestable/roadmap/2026-08-19-merge-e-hardening-into-d/merge-e-hardening-into-d-items.yaml`：M1 条目核对（回写前 `status: in-progress` + `feature: 2026-08-19-merge-e-hardening-base`，与协议一致）→ 已改 `status: done`；notes 修正两处事实：backup ref = `dee6771`（原文笔误 `990f988`）、补记"E 未携带 4.5 迁移实现，由 M1 在 D 侧新实现"；yaml 校验通过
- [x] 主文档 `merge-e-hardening-into-d-roadmap.md` 第 5.1 节：状态 `planned` → `done（2026-08-19 验收通过）`、对应 feature 回填；第 10 节变更日志追加 M1 验收与执行期修正记录（含 backup 锚点、4.5 前提纠正、withErrorSchema 过渡形态、shell.test.ts 归位）

## 8. AGENTS.md / CLAUDE.md 候选盘点

以下候选仅登记、不写入（AGENTS.md 当前口径归 M4 统一改写，且 roadmap 8 禁止提前改）：

- 候选 1：测试基线改为"34 文件 / 455 用例"（现"35 文件 / 599 用例"已过期）——建议 M4 更新 AGENTS.md 常用命令节
- 候选 2：状态目录约定：默认 `<projectRoot>/.etmcp`、`MCP_STATE_DIR` 相对 projectRoot 解析一次、设置后不迁移、legacy 全局 session 只提示不导入——建议 M4 补入 AGENTS.md 关键技术事实或已知坑
- 候选 3：MCP SDK 1.29 outputSchema 必须 normalize 成单一 object schema（union 调用期崩）——已沉淀 compound learning（`2026-08-19-learning-mcp-sdk-outputschema-single-object.md`），M4 可在 AGENTS.md 已知坑加一行指向
- 候选 4：headless 探针/CI 验证命令类工具时使用 `MCP_SAFETY_MODE=off`（与 e2e 一致）；无 elicitation 能力的客户端在 normal 模式会被 SafeGuard 要求确认——建议 M4 补入已知坑

## 9. 遗留

**后续工作（已立项）**：

- `codestable/issues/2026-08-19-cmd-powershell-inline-mojibake/`（report 已 confirmed，P2）：cmd/powershell 行内非 ASCII 乱码，pre-existing 非 merge 引入，用户拍板并入 M2（4.6 envelope 重写命令 schema 时一并处理）
- M2 `command-output-spill-paging`（4.6–4.12 A+ 契约，依赖 M1，已就绪可启动）
- M3 `publish-es-optional`、M4 `post-merge-doc-sync-and-acceptance`（含第 5 节差异清单收口）

**已知限制**：

- `result.ts` 错误结构当前为 `withErrorSchema` partial 形态（M1 过渡形态，SDK 1.29 约束下的正确实现）；M2 4.6 将收敛为完整单对象 envelope，属已预期演进点
- normal 模式下无 elicitation 能力的 MCP 客户端会被 SafeGuard 要求确认（by design；headless 验证用 off 模式）
- `.serena/` 不在 `.gitignore`，依赖流程纪律排除（从未进入 commit）；如希望根治可由用户决定补入 `.gitignore`

**实现阶段顺手发现**：

- `src/context.ts` 与 `src/pool.ts` 均未接入生产（预留能力），是否退役另走 issue/refactor（design 2.5 观察项已记）
- items.yaml 原文 notes 笔误（backup=`990f988`）已在第 7 节回写中修正
- 门禁命令经管道截取输出时需注意 shell 管道会掩盖被截断命令的退出码（本次验收一度因此漏看 shell.test.ts 导入失败；门禁复跑应使用 `pipefail`）
