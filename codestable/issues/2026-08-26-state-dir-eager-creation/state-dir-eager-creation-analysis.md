---
doc_type: issue-analysis
issue: 2026-08-26-state-dir-eager-creation
status: confirmed
severity: P2
root_cause_type: api-semantics-conflation
summary: getStateDir() 把路径解析与目录创建合并在同一函数，启动链路上三处"只需要路径"的消费（temp-manager init、session 恢复读取、audit 读/展示路径）继承了 mkdir 副作用
tags: [state-dir, lazy-init, session, temp-manager, audit, paging]
created: "2026-08-26"
---

# server 启动即创建空 .etmcp 目录 — 根因分析

## 1. 根因

### 1.1 核心：`getStateDir()` 解析即创建

`src/state-dir.ts:68-79` 的 `getStateDir()` 在首次调用时无条件执行 `fs.mkdir(dir, { recursive: true })` 再缓存路径——**任何调用方哪怕只是想拼一个文件路径，也会把 `.etmcp` 建出来**。

该语义有明确历史出处：2026-07-05 state-directory-migration 的 `design.md` 第 85 行写明"目录不存在时自动创建"。当时的消费者只有写路径（session 保存、audit 写入），解析即创建无害。但后续新增的消费者只需要路径，全部被波及。

### 1.2 启动链路上的触发点（按 index.ts 启动顺序）

| # | 调用链 | 路径性质 | 后果 |
|---|--------|---------|------|
| 1 | `index.ts:71 tempManager.init()` → `temp-manager.ts:229 await getStateDir()` | 只需要路径 | 创建空 `.etmcp`（最早触发点） |
| 2 | `index.ts:73 await session.loaded` → `session.ts:185 getStateFilePath()` → `getStateDir()` | 纯读（恢复 session.json，ENOENT 即 fresh） | 同上（此时已被 #1 缓存） |
| 3 | `audit://log` 资源读取 `index.ts:61 audit.recent()` → `audit.ts:105 getLogFile()`（内含 getStateDir + mkdir logsDir） | 纯读 | 创建空 `.etmcp/logs/` |
| 4 | `telemetry_report`（`utility.ts:444 audit.getLogFilePath()`）→ 同上 `getLogFile()` | 展示路径 | 同 #3 |

**最直接的讽刺证据**：`temp-manager.ts:224-226` 的注释原文写着"懒创建：只解析 root 路径，不 mkdir；root 已存在才扫描"，实现也确实小心地用 `lstatOrNull` 保证不创建 `temp/` 子目录——但父目录 `.etmcp` 在它调 `getStateDir()` 拼路径那一刻就被创建。设计意图（temp root 懒创建）在子目录一级实现成功，在父目录一级被底层 API 的副作用击穿。

**语义错配的反证**：同文件已有无副作用变体 `getStateDirSync()`（`state-dir.ts:84`，注释"不自动创建目录"），`es-integrity.ts:68` 与 `utility.ts:445`（temp_stats 展示）都正确使用它——"只解析不创建"的需求真实存在，只是异步消费路径没有对应的 API 可用，于是复用了带副作用的 `getStateDir()`。

### 1.3 波及但行为正确的路径（修复时的对照面）

- `paging.ts:986/1050`（page cache 读取 loadEntry/read）：同样调 `getStateDir()` 拼路径后被创建——也是受害者；读取路径后续用 lstat 检查，纯解析即可。
- `temp-manager.ts:395-401 ensureRoot()`：`mkdir(this.root, recursive)` 在真实创建 temp 资源时执行——真实产生物，正确。
- `audit.ts` flush 写入前 mkdir logsDir：真实产生物，正确（问题只在它被读路径复用）。
- `state-dir.ts:400 runStateMigration` 的 mkdir：仅在 legacy 目录存在、即将写迁移产物时执行，正确。

## 2. 文档口径的三层差距

1. **用户要求**（最严）：`.etmcp` 只在第一个真实产生物落盘时创建。
2. **文档口径**（ARCHITECTURE.md §4 / README）："`temp` 子目录懒创建；`.etmcp` 根可由 session/audit 按需创建"——根目录的提前创建已被文档默许，与用户要求有差距。
3. **实际行为**（最松）：连"按需"都不是——session/audit 一个字节未写，仅启动期路径解析就把空目录建出来。

修复应同时把实现和文档都收口到第 1 层口径。

## 3. 修复方案

### 3.1 原则：把"解析"与"确保存在"拆开，写路径显式 ensure

**`src/state-dir.ts`**
- `getStateDir()` 改为纯解析：resolve + 缓存路径字符串，不 mkdir（保持 async 签名，调用方零改动即获得正确语义）。
- 新增 `ensureStateDir()`：`getStateDir()` + `mkdir(recursive)`，失败保留原 `Failed to create state directory` 错误语义。**只有即将落盘真实产生物的写路径调用它。**

**`src/session.ts`**
- `saveToDisk()` 在 writeFile 前加 `await ensureStateDir()`（session.json 即真实产生物）。
- `loadFromDisk()` 不动——`getStateFilePath()` 随 getStateDir 纯化自动变为零副作用。

**`src/audit.ts`**
- `getLogFile()` 拆两半：`resolveLogFilePath()`（纯解析，memo 路径）与 `ensureLogFilePath()`（解析 + mkdir logsDir）。
- `flush()`（写）走 ensure；`recent()`（读）与 `getLogFilePath()`（展示）走纯解析，读 ENOENT 维持返回 `[]`。

**`src/temp-manager.ts` / `src/paging.ts`**：零代码改动——`init()` 与 page cache 读取随 getStateDir 纯化自动零副作用；`ensureRoot()` 的 mkdir 保留。

### 3.2 行为不变量（修复后）

- server 启动 + 零工具调用 + 零资源读取 → 项目目录无 `.etmcp`。
- 读 `audit://log` / `health://status`、`telemetry_report`、`temp_stats` → 无创建。
- 首次 session 持久化（首个 dirty 写，5s 去抖后）→ 创建 `.etmcp` + `session.json`。
- 首条 audit 写入 → 创建 `.etmcp/logs/audit.jsonl`。
- 首个 temp/page-cache 资源 → 创建 `.etmcp/temp/...`。
- legacy 迁移（存在旧目录时）→ 创建并写入迁移产物。

### 3.3 测试计划

- `tests/unit/state-dir.test.ts`：改旧契约（getStateDir 不再创建）+ 新增 `ensureStateDir` 创建/失败用例。
- 新增 `tests/unit/lazy-state-dir.test.ts`（用 `MCP_STATE_DIR` 指到项目内 `.etmcp/test-tmp/`）：
  - session 恢复不创建、saveToDisk 创建并落盘；
  - `tempManager.init()` 不创建 `.etmcp`，`create()` 创建 `.etmcp/temp`；
  - `audit.recent()` / `getLogFilePath()` 不创建，`record()+flush()`（errors/all 模式）创建 `logs/audit.jsonl`；
  - AuditLog 用新实例隔离 path memo。
- 新增 `tests/state-dir-lazy.test.ts`（e2e，随 `pnpm test` 运行，依赖 `build/`）：干净 cwd 拉起 server → connect + 读 `audit://log` → 断言 `.etmcp` 不存在 → 关闭清理。这是用户报障场景的等价回归。

### 3.4 文档同步

- ARCHITECTURE.md §4：改为"`.etmcp` 仅在首个真实产生物落盘时创建"，并更新 §3.2 state-dir 行与最后核对日期。
- README Features 增加 Lazy State Directory 一条。
- AGENTS.md 关键技术事实中状态目录一行补充根目录懒创建口径。

## 4. 风险与边界

- 纯行为收窄（从"提前创建"到"按需创建"），不改任何工具的输入输出契约；`.etmcp` 不存在时各读路径本来就按 ENOENT 处理。
- `ensureStateMigration()` 在读路径（session load、audit resolve）触发：`runStateMigration` 先 lstat legacy，不存在即 return，零副作用——无需改动。
- Windows / Unix 行为一致（全部走 Node fs 抽象）。
- 旧契约测试（state-dir.test.ts:29-40、:73-78）需同步改写，属本 issue 授权范围。
