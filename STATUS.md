# STATUS.md — 总体任务与进度快照（Agent 现状入口）

> **本文件面向下一次进入本仓库的 AI agent**：读完即可知道项目在做什么、进行到哪、下一步做什么、有哪些硬约束和踩过的坑。
> **维护规则**：每个 roadmap feature 收口（commit 落库 + 记忆更新）后，必须同步更新本文件的进度表、HEAD、下一步与坑清单。

- **快照时间**：2026-08-29
- **当前 HEAD**：`1308020`（工作树 clean）
- **最近一次全量回归**：`pnpm run gate` EXIT=0（66 文件 835 用例、latency 24/24、tools coverage 64.72/54.39/71.42/68.52 达标）

## 1. 项目一句话

Enhanced Terminal MCP v4.0.0：TypeScript ESM 的 MCP stdio 服务端，提供 **27 个**终端/文件/系统工具（`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时 **26 个**）；pnpm 11.21.0；推荐本机 profile `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`。

## 2. 总体任务

**生产硬化 roadmap**（`codestable/roadmap/2026-08-28-production-hardening/`，13 条子 feature 带 depends_on DAG），源自生产就绪审计 `codestable/compound/2026-08-28-explore-production-readiness-audit.md`（SEC/REL/PRO/OPS/SEARCH 编号与条目一一对应）。目标：把项目收敛为 `local-trusted-shell`（默认）与 `sandboxed-production` 两种显式 profile，补齐输入预算、进程治理、路径/秘密/网络策略、状态可观测性和发布门禁。

## 3. 当前进度（11/13 done）

| # | slug | 状态 | commit | 关闭的审计项 |
|---|---|---|---|---|
| 1 | hardening-contract-and-profiles | done | `268cbad` | 契约基座（RequestContext/BudgetAccount/strict schema/错误码） |
| 2 | process-supervisor-and-cancellation | done | `268cbad` | SEC-01/SEC-08、REL-03/REL-07 |
| 3 | bounded-command-execution | done | `476bd6e` | REL-02（最小闭环：budget + 可取消命令） |
| 4 | kill-process-identity | done | `268cbad` | SEC-01 P0（wildcard/PID reuse） |
| 5 | path-policy-no-follow | done | `ab54634` | SEC-03（symlink/TOCTOU） |
| 6 | secret-redaction-and-state-protection | done | `ba6671a` | SEC-04/SEC-05 |
| 7 | network-and-archive-safety | done | `22535f4` | REL-04/SEC-07（SSRF/zip） |
| 8 | audit-health-and-state-writer | done | `01151f3` | OPS-01/OPS-02、lock fencing、truthful health |
| 9 | tool-wrapper-and-surface-contract | done | `3397c52` | REL-05/PRO-01/PRO-02、SEC-06 capability 部分 |
| 10 | search-and-adaptive-correctness | done | `1308020` | SEARCH-01/02、SYS-01、PERF-01 |
| 11 | dependency-and-bootstrap-release | done | `268cbad` | SEC-02、REL-01/REL-06 |
| 12 | security-and-mcp-conformance-gates | **planned（依赖已全部满足，下一步）** | — | canonical CI gate、conformance、hostile-input |
| 13 | docs-and-architecture-closeout | planned（等 #12） | — | DOC-01（v3.1/28 残留文字统一等） |

各条目的设计/checklist/acceptance 三件套在 `codestable/features/YYYY-MM-DD-{slug}/`；审计文档 §6.1–§6.10 有每条的实施状态回写。

## 4. 执行方式（用户既定授权）

用户已将**整个 CodeStable 流程委托给 agent 代为执行**：design → 多轮审计（自行审计并修正，直到新一轮审计无新问题才定稿）→ checklist → 实现 → 门禁 → 验收（含反向审计）→ 五处文档回写（roadmap/items/audit explore/ARCHITECTURE/CHANGELOG+README）→ commit。**commit 决策也由代理决定**（scoped commit：只含本次工作相关改动）。仅重大产品决策需上报用户。

完整授权文本（原话要点、各阶段细则、"重大决策"判定标准、授权不覆盖的硬约束、与 AGENTS.md 条款的关系）见 **`CS-AUTOMATION.md`**——它是本节的权威来源，冲突时以其为准。

## 5. 下一步（按序）

1. **#12 `security-and-mcp-conformance-gates`**（依赖已全部满足，可立即开工）：hostile-input、MCP conformance、跨平台 smoke、canonical CI gate、action pinning、sandboxed capability e2e（#8/#9 遗留）、REL-09 transport close/fatal handler 统一收口。
2. **#13 `docs-and-architecture-closeout`**（等 #12）：统一 v4.0.0/27/26 的全部残留文字（usage-guide "NEW in v3.1" 段、SECURITY/依赖维护入口）、现状档案回写。

## 6. 关键约束与坑（踩过一次的，勿再踩）

- **工作流硬约束**：新 feature 走 `codestable/features/YYYY-MM-DD-{slug}/`，阶段不可跳；动手前先 `python codestable/tools/search-yaml.py --dir codestable --query "<关键词>"` 查归档防重复；文档落盘后跑 `validate-yaml.py`。
- **安全核心禁改**：`DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、safeguard 模式逻辑、security 硬底线——除非逐 issue 显式授权；错误码兼容表（roadmap §5.9）不得破坏。
- **SDK 1.29 关键约束**：`normalizeObjectSchema` 对 v3 ZodEffects（refine/superRefine/union）返回 `undefined` → `tools/list` 会把 inputSchema 广告成空 schema。**schema 层跨字段校验被阻断，action 依赖校验必须放 handler 层**；升级 SDK 必须连 outputSchema patch 一起验证。
- **tools 直调单测绕过 SDK zod 层**：schema 收紧必须配 handler 层同源校验才会被单测覆盖（kill-identity/bounded-command 先例）；字符计数一律用 code point（`Array.from`），UTF-16 `.length` 在 surrogate pair 上有差异。
- **session/state-dir 测试必须 `resetStateDirCache()`**：session 单例在模块导入时就解析并缓存状态目录——漏掉会把测试写入**真实** `.etmcp/session.json`（08-29 已发生过一次并恢复）。涉及 `MCP_STATE_DIR` 的测试 beforeEach/afterEach 都要 reset。
- **门禁与临时目录**：`pnpm run gate` 是唯一完整门禁；测试 `TEMP/TMP/TMPDIR` 显式指向项目内 `.etmcp/test-tmp`，**任何任务数据禁止落 C 盘**（含工具缓存/下载/npm-cache）。
- **vitest 输出解析坑**：输出带 ANSI 码，`grep "Tests  "` 匹配不到要用宽松模式；`grep failed` 会误中测试名（如 "reads a failed command cache"）。
- **机器特定路径**：pnpm store 在 `E:/pnpm/v11`（机器配置，不得写进仓库文件/发布物）。
- **已知遗留（非阻塞）**：cmd 链路无法携带带引号空格路径（修 spawnStream 需独立 issue）；SDK 1.30 升级等生态；README/AGENTS 中 #13 未收口的文字由 #13 统一处理。
- **全量测试高负载 flake**：lock-lease heartbeat 时序与 paging Windows rename EPERM 为既有 flake（非 #10 改动面，归 #12 评估加固），单跑与复跑均绿——遇到先复跑确认，再排查看改动面。

## 7. 权威文档索引

| 文档 | 用途 |
|---|---|
| `AGENTS.md` | 项目级硬约束入口（工作前必读） |
| `CS-AUTOMATION.md` | CodeStable 流程自动执行授权（用户委托的权威文本） |
| `codestable/roadmap/2026-08-28-production-hardening/production-hardening-roadmap.md` + `production-hardening-items.yaml` | 总任务定义、§5 接口契约（硬约束）、13 条状态 |
| `codestable/compound/2026-08-28-explore-production-readiness-audit.md` | 审计证据、问题编号、§6 各条目实施状态 |
| `codestable/architecture/ARCHITECTURE.md` | 架构现状与变更日志 |
| `codestable/features/*/` | 各 feature 的 design/checklist/acceptance 三件套 |
| `CHANGELOG.md` / `README.md` | 面向用户的变更与环境变量权威表 |
