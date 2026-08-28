# CS-AUTOMATION.md — CodeStable 流程自动执行授权

> **本文件记录用户对本仓库 AI agent 的既定授权**（2026-08-28 起生效，长期有效，未撤回前持续适用）：整个 CodeStable 流程由 agent 代为执行，不需要每个阶段征求用户批准。
> **维护规则**：授权边界只能由用户修改；agent 发现细则缺失时可以补充执行细则，但不得自行扩大授权范围。

## 1. 授权原文（用户原话要点）

1. "feature 采用你来代替我审计且多轮审计并修正的方式，直到新一轮审计没有新问题才停止审计并开始实现 feature"
2. "验收也是你来代替我执行"
3. "简而言之整个 cs 流程中除了非常重大的决策需要告知我，其他你来代为执行"
4. "commit 决策也是你来决定"

## 2. 授权含义（CodeStable 各阶段执行细则）

| 阶段 | agent 的代行方式 |
|---|---|
| design | 探索 + 写 design 文档；**定稿前由 agent 自做多轮审计并修正**——每轮检查范围越界、与既有归档/decision 冲突、契约破坏、风险盲点，发现即修；**连续一轮审计无新问题即视为定稿（approved）**，直接进入实现，不等用户批准 |
| checklist | agent 编写 `*-checklist.yaml` 并跑 `validate-yaml.py` 校验 |
| 实现 | 按 checklist 执行；实现中发现设计缺陷可修正 design，并在 acceptance 中记录偏差原因 |
| 门禁与验收 | agent 自行执行 `pnpm run gate` 等全部验证 + 反向审计（对照 design/checklist 逐项核对），验收报告由 agent 撰写，无需用户参与 |
| 文档回写 | roadmap/items、审计 explore §6、ARCHITECTURE changelog、CHANGELOG/README、`STATUS.md` 与记忆，均由 agent 在收口时完成 |
| commit | 是否 commit、何时 commit 由 agent 决定；**scoped commit**，只含本次工作相关改动，不夹带无关文件 |
| 下一任务选择 | 按 roadmap 的 depends_on DAG 顺序推进，无需逐条请示 |

## 3. 唯一例外：必须上报用户的"非常重大的决策"

出现以下任一情况时，停下来向用户说明并等待决定，不得代行：

- 改变产品边界或目标形态（如引入远程/多租户、更换执行模型）。
- 修改安全核心行为：`DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、safeguard 模式逻辑、security 硬底线、错误码兼容表——这些本来就要求逐 issue 显式授权，自动授权不延伸。
- 引入新的运行时依赖。
- 放弃、推迟或大幅重排 roadmap 条目（非 DAG 允许的自然顺序调整）。
- 具有产品含义的取舍且既有归档没有先例可依（如资源预算默认值、审计未决问题中的条目）。
- 破坏性或不可逆操作：删除用户数据、`git push --force`、改写历史、覆盖非本任务产物。
- 审计/门禁长期无法收敛，需要绕过门禁或降低验收标准才能收口。

判定原则：**会改变"这个项目是什么/承诺什么"的决策上报；在既定边界内把事做对的决策代行。**

## 4. 授权不覆盖的硬约束

本授权只转移 CodeStable 流程中的**批准权**，不豁免任何其他硬约束：

- `AGENTS.md` 的禁止事项全部照旧（安全核心禁改、契约不破坏、不引入运行时依赖等）。
- C 盘数据写入限制照旧：所有任务数据走非 C 路径（本项目内 `.etmcp/test-tmp` 等），无回退。
- "写代码遇到坏味道停下来与用户对齐"照旧：大文件加职责、函数超一屏、第 4+ 参数、copy-paste、万能工具类等信号仍需上报。
- `hardBlock` 等不可关闭底线不受任何模式或授权影响。

## 5. 与 AGENTS.md 条款的关系

- AGENTS.md "design 未经用户批准不写代码"：在本仓库依本授权解释为"**经 agent 多轮审计定稿即视为用户批准**"。
- AGENTS.md "未经用户明确同意，不执行 `git commit`"：依授权第 4 条解释为"**commit 决策由 agent 代行**"，仍受 scoped-commit 约束。
- 两处条款原文保留不改，以本文件为执行解释依据；冲突以本文件为准（用户直接指令优先级最高）。
