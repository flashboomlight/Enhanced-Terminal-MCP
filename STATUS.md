# STATUS.md — 总体任务与进度快照（Agent 现状入口）

> **本文件面向下一次进入本仓库的 AI agent**：读完即可知道项目在做什么、进行到哪、下一步做什么、有哪些硬约束和踩过的坑。
> **维护规则**：每个 roadmap feature 收口（commit 落库 + 记忆更新）后，必须同步更新本文件的进度表、HEAD、下一步与坑清单。

- **快照时间**：2026-08-30
- **当前 HEAD**：本 feature 收口提交（`feat: accelerate search_files on Linux/macOS with optional fd engine`；Linux parity 差距清单 6 项全闭环：3 个 issue + feature `2026-08-29-linux-fd-search` 落库；Linux release gate 11/11）
- **最近一次全量回归**：`pnpm run gate`（release 模式）11 阶段全部 passed（71 文件 841 用例、25 跳过、0 失败；主 coverage lines 82.09/branches 71.72/functions 82.16/statements 79.11、tools coverage lines 63.38、latency 通过）——Linux VPS 上含 fd 引擎接入后的回归

## 1. 项目一句话

Enhanced Terminal MCP v4.0.0：TypeScript ESM 的 MCP stdio 服务端，提供 **27 个**终端/文件/系统工具（`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时 **26 个**）；pnpm 11.21.0；推荐本机 profile `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`。

## 2. 总体任务

**生产硬化 roadmap**（`codestable/roadmap/2026-08-28-production-hardening/`，13 条子 feature 带 depends_on DAG），源自生产就绪审计 `codestable/compound/2026-08-28-explore-production-readiness-audit.md`（SEC/REL/PRO/OPS/SEARCH 编号与条目一一对应）。目标：把项目收敛为 `local-trusted-shell`（默认）与 `sandboxed-production` 两种显式 profile，补齐输入预算、进程治理、路径/秘密/网络策略、状态可观测性和发布门禁。

## 3. 当前进度（13/13 done，roadmap 闭环）

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
| 12 | security-and-mcp-conformance-gates | done | `0329ba6` | canonical CI gate、conformance、hostile-input、platform smoke、release evidence |
| 13 | docs-and-architecture-closeout | done | 本 feature 落库提交 | DOC-01（CHANGELOG/usage-guide/SECURITY.md/指引统一，v3.1/28 残留清零） |

各条目的设计/checklist/acceptance 三件套在 `codestable/features/YYYY-MM-DD-{slug}/`；审计文档 §6.1–§6.13 有每条的实施状态回写。**production-hardening roadmap 已全部完成（2026-08-29）**。

## 4. 执行方式（用户既定授权）

用户已将**整个 CodeStable 流程委托给 agent 代为执行**：design → 多轮审计（自行审计并修正，直到新一轮审计无新问题才定稿）→ checklist → 实现 → 门禁 → 验收（含反向审计）→ 五处文档回写（roadmap/items/audit explore/ARCHITECTURE/CHANGELOG+README）→ commit。**commit 决策也由代理决定**（scoped commit：只含本次工作相关改动）。仅重大产品决策需上报用户。

完整授权文本（原话要点、各阶段细则、"重大决策"判定标准、授权不覆盖的硬约束、与 AGENTS.md 条款的关系）见 **`CS-AUTOMATION.md`**——它是本节的权威来源，冲突时以其为准。

## 5. 下一步（用户已定排期，2026-08-29）

1. ~~cmd 链路带引号空格路径~~（已完成：issue `2026-08-29-cmd-quoted-space-path`，verbatim `/d /s /c` 修复 + gate 全绿）。
2. ~~lint 9 warnings 清理~~（已完成：`temp-manager.ts` 改 `Object.values`、`network-policy.test.ts` 8 处改 `_req`，lint 0 warning）。
3. ~~Windows 本机平台验证~~（**已完成，2026-08-29**）：①release gate 11/11 全 passed（Node v24.14.0；shell spec 走项目内置 `tools/pwsh` bundled 分支——本机 PATH 无 pwsh）；②真实 server 进程探针 4/4 PASS：tools/list=27、`ver` 成功证明 cmd 档生效、`type "带引号空格路径"` 端到端成功（cmd 修复的真实进程回归）、普通命令不受影响（探针脚本随 2026-08-29 上传前清理移除；要点=StdioClientTransport 起 `build/index.js` + `MCP_SHELL=cmd` + ver/type/echo 三命令，可按此重建）。本机仅有 Node 24 单运行时，Node 20/22 与 Linux/macOS 矩阵归 CI runner（外部证据边界不变）。
4. **SDK 1.30 升级挂起**——触发条件：某 1.x 版本确认修复 ZodEffects inputSchema 问题（届时可删 postinstall patch），或出现必须升级的安全通告。
5. ~~**Linux 验证由用户自行在 VPS 处理**~~（**已完成，2026-08-29**）：VPS 环境修复（node_modules 跨机拷贝损坏重装、pnpm 11 strictDepBuilds 机器级放行、补 zip/unzip）+ 16 条 Windows 耦合单测补平台守卫（issue `2026-08-29-linux-test-platform-guards`），Linux 全量 822 过/25 跳过/0 失败，工具层覆盖 89/89；全程问题记录见根目录 `LINUX-VALIDATION-ISSUES.md`。
6. ~~**Linux parity 差距清单实现**~~（**已完成，2026-08-30**）：Issue A README Linux Notes + CI ubuntu 单测/双覆盖 job（`2026-08-29-linux-parity-docs-and-ci`）；Issue B latency best-of-3 采样防抖 + 非 Windows coverage 阈值平台化（`2026-08-29-linux-gate-parity`）；Feature C 非 Windows `search_files` 可选 fd/fdfind 引擎加速（`codestable/features/2026-08-29-linux-fd-search/`，`ENHANCED_TERMINAL_FD_PATH` 显式 fail-closed，新增 19 条单测含真实 fd 10.4.2 冒烟）。差距清单 6 项全闭环；CI 的 unit-tests-linux job 待合并后由 GitHub Actions 实证（本机无法模拟 runner，已记录为预期边界）。
7. **发版决策**（4.1.0 建议，用户产品决策）：平台验证与 Linux parity 均已完成，随时可进行，含 CHANGELOG [Unreleased] 定版、tag、publish。

## 6. 关键约束与坑（踩过一次的，勿再踩）

- **工作流硬约束**：新 feature 走 `codestable/features/YYYY-MM-DD-{slug}/`，阶段不可跳；动手前先 `python codestable/tools/search-yaml.py --dir codestable --query "<关键词>"` 查归档防重复；文档落盘后跑 `validate-yaml.py`。
- **安全核心禁改**：`DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、safeguard 模式逻辑、security 硬底线——除非逐 issue 显式授权；错误码兼容表（roadmap §5.9）不得破坏。
- **SDK 1.29 关键约束**：`normalizeObjectSchema` 对 v3 ZodEffects（refine/superRefine/union）返回 `undefined` → `tools/list` 会把 inputSchema 广告成空 schema。**schema 层跨字段校验被阻断，action 依赖校验必须放 handler 层**；升级 SDK 必须连 outputSchema patch 一起验证。
- **tools 直调单测绕过 SDK zod 层**：schema 收紧必须配 handler 层同源校验才会被单测覆盖（kill-identity/bounded-command 先例）；字符计数一律用 code point（`Array.from`），UTF-16 `.length` 在 surrogate pair 上有差异。
- **session/state-dir 测试必须 `resetStateDirCache()`**：session 单例在模块导入时就解析并缓存状态目录——漏掉会把测试写入**真实** `.etmcp/session.json`（08-29 已发生过一次并恢复）。涉及 `MCP_STATE_DIR` 的测试 beforeEach/afterEach 都要 reset。
- **门禁与临时目录**：`pnpm run gate` 是唯一完整门禁；测试 `TEMP/TMP/TMPDIR` 显式指向项目内 `.etmcp/test-tmp`，**任何任务数据禁止落 C 盘**（含工具缓存/下载/npm-cache）。
- **canonical gate**：`pnpm run gate` 默认执行 release blocking gate；CI 使用同一脚本的 `pnpm run gate -- --ci`，仅把 latency 明确记录为 advisory；gate report 位于 `.etmcp/gate-report.json`，package/consumer 临时物位于 `.etmcp/gate-work` 或 release verifier 的 `.etmcp` 范围。
- **vitest 输出解析坑**：输出带 ANSI 码，`grep "Tests  "` 匹配不到要用宽松模式；`grep failed` 会误中测试名（如 "reads a failed command cache"）。
- **机器特定路径**：pnpm store 为机器级配置（用 `pnpm store path` 查询本机实际路径），具体路径不得写进仓库文件/发布物。
- **已知遗留（非阻塞）**：SDK 1.30 升级等生态（触发条件见下）；README/AGENTS/ARCHITECTURE 中部分历史文字已由 #13 收口，剩余历史版本段为有意保留。cmd 链路带引号空格路径已修复（`2026-08-29-cmd-quoted-space-path`：verbatim `/d /s /c` + 整体引号）。
- **全量测试高负载 flake**：#12 已将 lock-lease heartbeat 改为串行续租、测试改为等待可观察 heartbeat，并为 Windows staging rename 增加有界 EPERM/EBUSY/EACCES 退避；#13 又修复 paging 测试 afterEach `fs.rm` 的 ENOTEMPTY 竞态（`maxRetries: 10, retryDelay: 100` 有界重试——100ms TTL 异步 sweep 在高负载下晚于枚举写入所致；修复前两次全量各挂 1 个不同用例、定向 5/5 过）。有界重试不吞错；后续其他测试如再现同类 flake 按同款逐文件处理，并继续观察 CI runner 矩阵稳定性。
- **Linux/VPS 环境三坑**（2026-08-29 VPS 验证实录，详见根目录 `LINUX-VALIDATION-ISSUES.md`）：①node_modules 不可跨机器/跨平台拷贝——pnpm 的符号链接视图与平台原生包在拷贝后全毁，必须目标机 `pnpm install` 重装；②pnpm 11 默认 `strictDepBuilds=true` 会把依赖构建脚本未批准变成 install 硬失败、阻断所有 `pnpm run`——机器级处置是全局 `config.yaml` 写 `strictDepBuilds: false`（`onlyBuiltDependencies`/`allowBuilds` 全局不生效，仅项目级 `pnpm-workspace.yaml` 可用）；③Linux 归档工具依赖系统 `zip`/`unzip` 二进制（README 只文档化了 Windows 侧依赖）。
- **单测套件的 Windows 语义耦合**：`resolveShell` 的 win32 路径拼接/绝对性判定、`wrapCommand` 的 chcp 前缀按 `IS_WIN` 条件化、`kill -15/-9` 信号恒显式、关键进程名单分平台——写跨平台测试时按 issue `2026-08-29-linux-test-platform-guards` 的手法补守卫或平台感知断言；e2e-latency 的 tools/list 200ms 阈值在共享 VPS 高负载下会边缘越限（P-11），release gate 以维护机/CI 为准。
- **外部 CLI 参数必须真机冒烟钉死**：fd 的绝对路径 flag 是单数 `--absolute-path`（fd 10.x 对复数形 `--absolute-paths` exit 2）——设计稿/记忆中的 flag 名不能替代真实二进制验证；fd 遍历错误写 stderr 而退出码仍为 0，partial 判定看 stderr 非空行计数（feature `2026-08-29-linux-fd-search` 实测）。

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
