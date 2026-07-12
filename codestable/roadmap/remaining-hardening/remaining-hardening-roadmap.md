---
doc_type: roadmap
slug: remaining-hardening
status: active
created: 2026-07-12
last_reviewed: 2026-07-12
implementation_note: "2026-07-12 A-track landed except contract-truncate-success and publish-es-optional; B-track design spikes in drafts/"
tags: [security, command-policy, sandbox, secrets, deps, product-boundary]
related_requirements: []
related_architecture: [ARCHITECTURE]
summary: >
  汇总 2026-07 安全与工程质量 hardening 之后仍未闭环、且不能再靠挤牙膏式补丁推进的全部剩余工作。
  分三轨：A 应用层可落地增强、B 产品模型级改造、C 明确不做/永久边界。每条子 feature 可独立开 cs-feat。
---

# 剩余 hardening 与产品边界（完整规划）

## 1. 背景

Enhanced Terminal MCP 在 2026-07-11～12 完成了多轮安全与可靠性加固（hardBlock、session 恢复消毒、路径 realpath、es.exe 哈希、命令 allow 策略、密钥不入缓存、测试迁移、零依赖 postinstall 等）。工作区与测试已绿。

**仍存在的问题不再是“漏改一个文件”，而是三类性质不同的债：**

| 轨道 | 性质 | 能否继续堆正则/小 PR 解决 |
|------|------|---------------------------|
| **A · 应用层增强** | 在现有 shell 字符串执行模型内，可测、可验收的增强 | 可以，适合 feature 流程 |
| **B · 产品模型改造** | 改变 `execute_command` 语义或执行形态 | 不可以只靠补丁，需设计拍板 |
| **C · 永久边界** | 问题在 OS/数学/产品定位上不可解或不应解 | 应写清“不做”，避免无限迭代 |

本 roadmap 的目的：**一次写清全貌**，后续只按 `items.yaml` 启动子 feature，不再靠对话碎片推进。

### 1.1 已完成（本 roadmap 不再重复做）

- hardBlock 全模式底线 + 解释器/管道扩展（见 compound decision hardblock）
- session.json cwd/env 恢复消毒
- Windows 系统盘动态 forbidden paths + writeRealPath
- temp-manager 防穿越、touch 去抖
- 路径多层 URL 解码穿越检测
- 命令输出分页 + TempManager
- es.exe SHA-256 校验（`es-integrity`）
- `MCP_COMMAND_POLICY=allow` 词级白名单 + 禁 shell 元字符
- 缓存命中前 `scanContent`，密钥内容不入 LRU
- 单测迁至 `tests/unit/`；`patch-package` 仅 devDep；postinstall 零依赖脚本
- state-persistence roadmap Phase 1–6 已 completed

### 1.2 触发本规划的“剩余边界”清单（对照表）

| ID | 边界 | 当前状态 | 归属轨道 |
|----|------|----------|----------|
| B1 | 任意 shell 字符串无法用正则证明安全 | hardBlock + allow 尽力而为 | **B / C** |
| B2 | allow 模式无完整引号/转义解析 | 元字符一律拒（宁可误拦） | **A** 可改进解析；**C** 不承诺完备 |
| B3 | 密钥扫描启发式误报/漏报 | 自研正则 + 4MB 上限 | **A** 可换引擎或分层策略 |
| B4 | zod 仍在 v3 | SDK 兼容 3\|\|4，未迁移 | **A** 技术债 |
| B5 | `pool_stats` 空壳产品 | inactive stub，已诚实标注 | **A** 可删/改契约或真激活（风险高） |
| B6 | 大输出截断仍 `isError=true` | partial 在 error message | **A** 需改 outputSchema（契约） |
| B7 | batch 限流按批 1 token | 防循环弱防资源打满 | **A** |
| B8 | 内容级密钥仍可读出（只是不缓存） | 读路径不拦密钥正文 | **A/C** 与工具定位冲突 |
| B9 | OS 级隔离（容器/Job Object） | 无 | **B** |
| B10 | argv 数组执行替代 shell 字符串 | 无 | **B** |

---

## 2. 范围与明确不做

### 本 roadmap 覆盖

- 命令策略（command-policy / hardBlock）在应用层的可验收增强
- 密钥扫描策略与缓存/读路径的产品行为对齐
- 契约内/契约变更类的可靠性与可观测性收口
- 依赖与发布面技术债（zod、补丁、es 二进制策略）
- **文档化** B 轨产品模型选项，供未来单独开 epic

### 明确不做（C 轨 — 永久或长期边界）

1. **不承诺“任意 shell 输入在正则层完备安全”**  
   在保留 `cmd.exe /c` / `sh -c` 整串执行的前提下，应用层黑/白名单只能是纵深防御，不是形式化安全。  
   完备安全需要：OS 沙箱、或禁止 shell 只接受 argv、或受控 DSL。见决策文档 `decision-command-execution-not-sandbox`。

2. **不做完整 shell 语法解析器（shlex + 全 shell 语义）作为安全核心**  
   引号嵌套、编码、环境展开、别名、函数定义等组合爆炸；误拦会毁掉 AI 终端产品价值。allow 模式当前策略是“禁元字符”，不是“正确解析后放行危险子集”。

3. **不在默认模式下把 `execute_command` 改成“只能跑白名单”**  
   默认 `blocklist` 保留任意命令能力；`allow` 是**可选加固配置**，不是替换默认产品语义。

4. **不把 gitleaks/trufflehog 等重型扫描器默认打进生产依赖**  
   除非单独 feature 评估体积、许可证、冷启动与误报；可先做可选插件路径。

5. **不在本 roadmap 内做跨平台 GUI / Everything 非 Windows 等价物**  
   `everything_search` 保持 Windows-only 是产品边界，不是缺陷清单项。

6. **不在本 roadmap 内升级 MCP SDK 主版本或重写协议层**  
   仅记录 zod 与 SDK 兼容窗口；大升级另开 roadmap。

---

## 3. 模块拆分（概设）

```
remaining-hardening
├── M1 command-policy-runtime   命令策略与 hardBlock 运行时
├── M2 secrets-and-cache        密钥扫描、读路径、缓存策略
├── M3 tool-contracts           工具 I/O 契约与限流/截断语义
├── M4 supply-chain-publish     依赖、补丁、es 二进制、发布物
└── M5 product-model-options    产品模型级方案（只规划不默认实现）
```

### 模块 M1 · command-policy-runtime

- **职责**：`checkCommandPolicy` / `hardBlock` / 环境变量策略；不负责 OS 隔离
- **触碰代码**：`src/command-policy.ts`、`src/security.ts`、`src/tools/command.ts`
- **承载子 feature**：`cmd-allow-structured-argv`、`cmd-policy-audit-metrics`、`cmd-hardblock-regression-corpus`

### 模块 M2 · secrets-and-cache

- **职责**：`scanContent`、写拦截、读结果是否缓存/是否告警
- **触碰代码**：`src/scan.ts`、`src/wrap.ts`、`src/tools/files.ts`、`src/cache.ts`
- **承载子 feature**：`secrets-scan-tiers`、`secrets-read-policy`、`secrets-optional-engine`

### 模块 M3 · tool-contracts

- **职责**：outputSchema、错误语义、限流粒度、pool 工具产品真相
- **触碰代码**：`src/tools/command.ts`、`src/ratelimit.ts`、`src/pool.ts`、`src/tools/utility.ts`、`src/stream.ts`
- **承载子 feature**：`contract-truncate-success`、`contract-batch-ratelimit`、`contract-pool-stats-retire`

### 模块 M4 · supply-chain-publish

- **职责**：发布 `files`、postinstall、锁定哈希、可选 zod 迁移
- **触碰代码**：`package.json`、`scripts/`、`es_tool/`、`src/es-integrity.ts`
- **承载子 feature**：`publish-es-optional`、`deps-zod-v4-spike`、`publish-sbom-hash-doc`

### 模块 M5 · product-model-options

- **职责**：记录“真沙箱 / argv 执行 / 双工具模型”的可选架构，**默认不实现**
- **触碰代码**：无（规划层）
- **承载子 feature**：`model-argv-execute-design`（仅 design/spike）、`model-os-sandbox-spike`（仅 spike）

---

## 4. 模块间接口契约 / 共享协议

### 4.1 命令策略统一入口（M1 → command tools）

**方向**：`command.ts` → `command-policy.ts` → `security.hardBlock`  
**形式**：函数调用  

**契约**：

```ts
// src/command-policy.ts
export type CommandPolicyMode = "blocklist" | "allow"

export function getCommandPolicyMode(): CommandPolicyMode
export function getAllowPrefixes(): string[]
/** 返回 null 表示放行；非 null 为人类可读拦截原因（写入 audit.detail.reason） */
export function checkCommandPolicy(command: string): string | null
export function firstExecutableToken(command: string): string
```

**约束**：

- `checkCommandPolicy` **必须先**调用 `hardBlock`；任何模式不得跳过
- `allow` 模式下若检测到 shell 元字符 / 嵌套 shell，必须拦截（当前实现）
- 环境变量：
  - `MCP_COMMAND_POLICY`：`blocklist`（默认）| `allow` | 别名 `whitelist`→`allow`
  - `MCP_COMMAND_ALLOW`：逗号分隔；空则用内置默认可执行名列表
- 错误码：统一 `ErrorCode.COMMAND_DANGEROUS`，消息前缀 `Command blocked —`；工厂 `Errors.commandBlocked(cmd, reason, param)`
- **禁止**在 `command.ts` 内再分叉一套正则绕过 `checkCommandPolicy`

### 4.2 hardBlock 硬底线（M1 内部 / AGENTS 红线）

**形式**：`hardBlock(cmd: string): string | null`  

**约束**（与 DEC hardblock 一致并扩展）：

- 全模式（含 off）在三个命令工具入口生效
- 扩展 `HARD_BLOCK_PATTERNS` 须逐 issue 授权；优先漏拦边缘、禁止误拦常用开发命令
- 应用层 hardBlock **不是**沙箱完备性证明

### 4.3 密钥扫描与缓存（M2 → wrap / files）

**契约**：

```ts
// src/scan.ts
export const SCAN_CONTENT_MAX_BYTES: number  // 默认 4MiB
export function scanContent(content: string): { safe: boolean; findings: string[] }

// src/wrap.ts（缓存写路径）
// 仅当 result.ok && scanContent(extractText(callResult)).safe 时 toolCache.set(...)
```

**约束**：

- 写文件：`write_file` 在 ≤ SCAN_CONTENT_MAX_BYTES 时 `!scan.safe` → `PATH_SENSITIVE`，不写盘
- 读结果：默认**允许**返回含密钥的正文（工具是终端/读文件能力）；**禁止**把含密钥发现的成功结果写入 LRU
- 若未来“读也拦截密钥”，必须新环境变量显式开启（见子 feature `secrets-read-policy`），默认 off，避免破坏合法读配置场景

### 4.4 工具契约变更门禁（M3）

**约束**（对齐 AGENTS.md）：

- 改 `outputSchema` / 删工具 / 改必填字段 → **必须**用户逐 issue 显式授权
- `contract-truncate-success` 若要把截断改为 `ok:true + truncated:true`，授权范围写清旧客户端兼容策略
- `pool_stats` 若删除或改 structured 字段，同契约红线

### 4.5 发布与完整性（M4）

**契约**：

```ts
// src/es-integrity.ts
export const ES_EXE_SHA256: string  // 小写 hex
export function ensureEsExeIntegrity(): Promise<string | null>  // 通过返回路径，失败 null
```

**约束**：

- 更新 `es_tool/es.exe` 必须同步改 `ES_EXE_SHA256` + 单测/文档
- `postinstall` 只跑 `scripts/apply-mcp-sdk-patch.mjs`；不得把 `patch-package` 放回 dependencies
- `package.json#files` 含 `build/`、`es_tool/es.exe`（若仍打包）、`scripts/apply-mcp-sdk-patch.mjs`、文档；`patches/` 仅仓库开发参考

### 4.6 产品模型选项（M5）— 仅文档契约

若未来实现 argv 模式，**建议**新工具或显式参数（避免静默破坏）：

```ts
// 方案示意 — 未实现，禁止在未走 design 前当事实引用
execute_command_argv: {
  file: string,           // 可执行文件绝对路径或 PATH 名
  args: string[],         // 不再经 shell
  cwd?: string,
  env?: Record<string,string>  // 仍须 session env 消毒
}
// 安全：不调用 shell；hardBlock 改为对 file 基名 + 可选 args 扫描；allow 只匹配 file 基名
```

**无跨模块运行时接口**直至 `model-argv-execute-design` 获批并进入 in-progress。

---

## 5. 子 feature 清单

顺序按依赖与“先文档/低风险、后契约/高风险”。状态初始均为 `planned`。

### 轨道 A · 应用层（默认可开干）

1. **cmd-hardblock-regression-corpus** — 建立 hardBlock/allow/dangerous 的回归语料库与 CI 单测  
   - 模块：M1  
   - 依赖：无  
   - **最小闭环：是**（做完即有可重复安全回归，不改生产默认行为）  
   - 验收要点：语料分“必须拦 / 必须放 / 允许误拦”；`npm test` 覆盖；文档说明如何追加样本  

2. **cmd-policy-audit-metrics** — 策略拦截写入 telemetry/audit 可聚合字段（mode、reason 类别）  
   - 模块：M1  
   - 依赖：无  
   - 验收：`telemetry_report` 或 audit 可区分 hardBlock / allow / dangerous  

3. **secrets-scan-tiers** — 扫描分级：`off | write | cache | strict`（环境变量）  
   - 模块：M2  
   - 依赖：无  
   - 验收：默认行为与现网一致；`strict` 文档化；超大文件策略不变  

4. **secrets-read-policy** — 可选“读路径发现密钥时告警或拒绝缓存已有；可选拒绝返回”  
   - 模块：M2  
   - 依赖：`secrets-scan-tiers`  
   - 验收：默认不破坏 read_file；显式 env 才拒绝返回  

5. **contract-batch-ratelimit** — batch_execute 限流可配置：按批 / 按条 / burst  
   - 模块：M3  
   - 依赖：无  
   - 验收：环境变量文档化；默认保持现行为（按批 1 token）  

6. **contract-pool-stats-retire** — 二选一落地：删除 pool_stats **或** structured 增加 `active:false` 且文档/测试固定  
   - 模块：M3  
   - 依赖：无  
   - 备注：若删除工具 → **契约变更，需显式授权**  

7. **contract-truncate-success** — 超大输出：`ok:true` + `truncated:true` + partial stdout（改 outputSchema）  
   - 模块：M3  
   - 依赖：无  
   - 备注：**契约变更，需显式授权**；兼容策略写 design  

8. **publish-sbom-hash-doc** — 发布清单：es 哈希、补丁脚本、依赖锁定说明写入 README/CHANGELOG 固定节  
   - 模块：M4  
   - 依赖：无  

9. **publish-es-optional** — es.exe 改为 optional 平台包或 postinstall 下载+校验，缩小非 Windows 安装物  
   - 模块：M4  
   - 依赖：`publish-sbom-hash-doc`  
   - 备注：改变安装体积与 files 字段  

10. **deps-zod-v4-spike** — zod v4 迁移 spike：兼容矩阵、SDK、改动面评估，产出 go/no-go  
    - 模块：M4  
    - 依赖：无  
    - 备注：本条**只做 spike 文档+可选分支**，不默认 merge 生产  

### 轨道 B · 产品模型（先 design/spike，默认不实现）

11. **model-argv-execute-design** — 设计 `execute_command_argv` 或 `shell:false` 双模式；写清安全模型、兼容、迁移  
    - 模块：M5  
    - 依赖：`cmd-hardblock-regression-corpus`（语料可复用）  
    - 备注：design 批准前**禁止**改默认 execute_command 行为  

12. **model-os-sandbox-spike** — Windows Job Object / Linux seccomp-bpf / 容器包装可行性 spike  
    - 模块：M5  
    - 依赖：`model-argv-execute-design`（先定是否还走 shell）  
    - 备注：仅调研与 PoC 笔记；引入运行时依赖须单独授权  

### 明确不做条目（记入 items 为 dropped 种子，防止再提）

见 items.yaml 中 `status: dropped` 的条目（完整 shell 完备证明、默认强制 allow、默认生产打 gitleaks 等）。

**最小闭环**：第 1 条 `cmd-hardblock-regression-corpus` 做完后，安全回归不依赖人工“再想几条绕过”，后续任何 hardBlock/allow 改动都有语料闸门。

---

## 6. 排期思路

1. **先最小闭环（语料库）** — 零产品行为变化、立刻降低回归成本。  
2. **并行低风险 A 项** — audit 指标、发布文档、batch 限流可配置（默认不变）。  
3. **契约变更项单独授权** — truncate 语义、pool_stats 删除。  
4. **密钥策略** — 先分级扫描，再可选读拦截。  
5. **B 轨永远后置** — 无 design 批准不写生产代码；避免与“AI 万能 shell”产品定位冲突时硬上沙箱。  

建议节奏（可调，非承诺）：

| 阶段 | 条目 | 产出 |
|------|------|------|
| W0 | #1 语料库 | tests + 文档 |
| W1 | #2 #5 #8 | 可观测 + 限流开关 + 发布文档 |
| W2 | #3 #4 | 密钥策略 |
| W3 | #6 #7（授权后） | 契约清理 |
| W4+ | #9 #10 | 安装物 / zod spike |
| 独立 epic | #11 #12 | 产品模型 |

---

## 7. 观察项

- **architecture/ARCHITECTURE.md** 已部分对齐 pool/es/policy；本 roadmap 落地后由 `cs-feat-accept` 回写细节，勿在 feature 中重复写“未来计划”进 architecture。  
- **旧 decision hardblock** 正文“已知边界”仍写 perl 等高阶绕过；hardBlock 已扩展后应 **supersede 或 update** 该 decision 的“已知边界”段落（本规划落盘时同步写新 decision，见 compound）。  
- **requirements/** 仍空：若产品对外承诺“安全终端”，建议另起 `cs-req` 写能力边界用户故事，与本 roadmap C 轨一致。  
- **MCP 客户端差异**：strict 模式依赖 Elicitation；无 Elicitation 客户端在 normal 下行为已有 e2e；B 轨沙箱不消除该差异。  
- **性能**：密钥扫描进 wrap 缓存路径已对成功结果跑 `scanContent`；若误报导致缓存命中率下降，用 telemetry 观察后再调阈值。  

---

## 8. 如何使用本规划（给执行者）

1. 打开 `remaining-hardening-items.yaml`，选一条 `status: planned`。  
2. 说「开始做 roadmap remaining-hardening 的 {slug}」。  
3. `cs-feat-design` 必须把 **第 4 节接口契约**当硬约束；要改契约先 `cs-roadmap update`。  
4. 验收时 `cs-feat-accept` 回写 items `done`。  
5. **禁止**在未更新本 roadmap 的情况下开启“再加几条 hardBlock 正则”的开放式任务——一律挂到 #1 语料库或新 item。  

---

## 9. 变更日志

- 2026-07-12：初版。汇总 hardening 后剩余 A/B/C 三轨；定义 M1–M5 与 12 条 planned + dropped 种子；最小闭环为 hardBlock 回归语料库。
- 2026-07-12（落地）：完成 corpus / audit metrics / secrets tiers+read / batch rate mode / pool `active` / publish docs / zod+argv+sandbox spikes。仍 planned：`contract-truncate-success`（契约授权）、`publish-es-optional`。
