---
doc_type: feature-acceptance
feature: 2026-08-28-command-risk-gated-confirmation
status: done
summary: 对照 design 完成确认模型收敛：headless surface 整体拆除（27 工具、旧 env 惰性）、MCP_COMMAND_CONFIRMATION 分级确认落地、五门禁全绿、实证与语料回归全过
tags:
  - security
  - confirmation
  - risk-gated
  - official-alignment
  - acceptance
created: "2026-08-28"
---

# command-risk-gated-confirmation 验收

## 1. 交付范围

- **拆除**：`src/headless-policy.ts`、`src/workspace-delete.ts`（两模块删除）；`src/index.ts` initHeadlessPolicy；`src/safeguard.ts` ConfirmationMode/_confirmationMode/getConfirmationMode/isHeadless*/headless 决策分支/组合告警改写；`src/tools/manage.ts` delete_preview 与 preview_id 分支；`src/tools/files.ts` headlessSurfaceBlock 两调用点；`src/tools/utility.ts` health/safety-info 的 confirmation_mode/allowed_roots/headless_surface 字段。src/ 下 grep headless/MCP_ALLOWED_ROOTS/MCP_CONFIRMATION_MODE/delete_preview 零残留（`source: "elicitation" | "policy"` 联合类型同步收窄）。
- **新增**：`src/command-risk.ts`（parseCommandConfirmationMode / classifyCommandRisk / classifyBatchRisk / 规则表数据化：batch>5、破坏类残余 7 条线性正则、性能词表、watch duration>60000ms、超长 fail-safe heavy）；`src/safeguard.ts` 新增 `guardCommandByRisk`（strict 优先 → ordinary 放行 → heavy `elicitInput` 带风险原因；heavy 三态统一写 `safety.decision` 审计含 `risk_level`/`risk_category`，不写命令原文）+ P2 组合日志；`src/tools/command.ts` 统一闸 `commandSafetyGate` 接入三工具（risk-gated 拒绝体附风险原因、batch 整批一次确认、确认前不 spawn）。
- **测试**：删 `tests/workspace-delete.test.ts`、`tests/unit/workspace-delete.test.ts`、`tests/unit/headless-policy.test.ts`；`safeguard.extended.test.ts` 重写 headless describe 为 risk-gated 分级与审计 11 用例；新增 `tests/unit/command-risk.test.ts`（语料驱动）+ `tests/fixtures/command-risk-corpus.json` + `tests/command-risk-gated.test.ts`（e2e）；`tool-visibility`/`e2e-latency` 工具数 27/26 同步。
- **文档**：README（27 tools、env 表增 MCP_COMMAND_CONFIRMATION 删两旧行、推荐配置、删 delete_preview 行与 headless 段落、v4.0）；ARCHITECTURE（SafeGuard/command-risk 模块行、ADR-5 决策序、新增 ADR-18）；AGENTS.md 安全双层行补新变量；CHANGELOG 4.0.0；package.json → 4.0.0；design §2.1 guardCommandByRisk 签名同步为实现口径（结构化 `{decision, risk}` 返回）。

## 2. 门禁结果（全绿）

| 门禁 | 结果 |
|---|---|
| `pnpm run build` | ✓（v4.0.0） |
| `pnpm exec tsc --noEmit` | ✓ |
| `pnpm run lint`（biome check） | ✓ 0 error 0 warning |
| `pnpm test` | ✓ 43 文件 / 573 用例 |
| `pnpm run test:latency` | ✓ 24/24 |

## 3. 关键场景证据

- **A2/A3/A12**：e2e off+risk-gated 下 `echo` 免确认执行成功；单测 ordinary 组（含 `echo install` token 语义防误伤）全 ordinary。
- **A4/A5**：语料边界 5 条 ordinary / 6 条 heavy(batch)；e2e batch 6 条无能力客户端返回 `ELICITATION_REQUIRED` 且无部分执行。
- **A6/A10**：单测 heavy 确认消息含“破坏类操作”原因与命令文本；accept → 审计 `decision:"allow"` + `risk_level/risk_category` 且无命令原文；decline → `ELICITATION_CANCELLED`。
- **A7/R5**：e2e 与语料证实 `rm -rf /`、`Remove-Item -Recurse -Force D:\x`、`echo iex` 在策略层直接 `COMMAND_DANGEROUS`，`DANGEROUS_PATTERNS`/`HARD_BLOCK_PATTERNS`/错误码表零 diff。
- **A8/D4**：watch duration 缺省/60s ordinary、>60000ms heavy(watch)。
- **A9/A11**：无能力客户端 required；strict 优先于分级（单测）。
- **A13**：非法值回退 all + 告警（单测）。
- **A14**：非命令工具零改动（headless 排除分支除外），off/normal 行为不变。
- **R1（实证，用户旧配置残留 env：`MCP_CONFIRMATION_MODE=headless` + `MCP_ALLOWED_ROOTS=E:\...` + off + risk-gated）**：server 正常启动无告警无拦截、27 工具无 delete_preview、`echo` 直通、`pnpm install` → `ELICITATION_REQUIRED`、`rm -rf /` → 直接拒；P2 组合日志按预期输出。
- **R2**：e2e tools/list 27 / tool-visibility 26（FILE_INFO=1）。
- **R3**：e2e off（all 模式）命令直接放行、6 条批量整批执行成功。
- **R4**：delete_path schema 无 preview_id（注册代码与 outputSchema 核对）。

## 4. 遗留与说明

- risk-gated 分类层不覆盖 hardBlock/DANGEROUS_PATTERNS 命中（策略层先行直接拒，P1 分界）；正则文本级误拦（如 `echo iex` 命中 hardBlock）为 DEC-001 已知边界，另行立 issue。
- implementation note：`guardCommandByRisk` 返回结构化 `{decision, risk}` 而非草案 string（支持精确错误码映射与错误体附原因），design §2.1 已同步。
- 消费者迁移：删除客户端配置中的 `MCP_CONFIRMATION_MODE`/`MCP_ALLOWED_ROOTS`（残留亦无害）；如需分级体验设置 `MCP_COMMAND_CONFIRMATION=risk-gated`。
