---
doc_type: roadmap
slug: merge-e-hardening-into-d
status: completed
created: 2026-08-19
last_reviewed: 2026-08-28
tags: [merge, hardening, command-output, powershell, supply-chain]
related_requirements: [powershell-default-shell]
related_architecture: [ARCHITECTURE]
---

# 将 E 线安全加固完整合入 D 线

## 1. 背景

Enhanced Terminal MCP 当前存在两条从同一祖先分叉的本地 `main`：

| 角色 | 仓库 | 本次固定 commit |
|---|---|---|
| D 合并前基线 | `D:\ALL MCP\Enhanced Terminal MCP` | `7eea8624934b313e4eb8cb40b7f8751df5297530` |
| E 合并输入 | `E:\MCP 开发\Enhanced Terminal MCP` | `e28f2e997956480032ec59bd465738ad1a81feb6` |
| 共同祖先 | 两个仓库共同持有 | `d4302243ae43f70b4bed8eb69600734c5c50e81f` |

经核验：

- D 从共同祖先向前 3 个 commit，包含 Windows 默认 pwsh、`file_info` 开关及旧合并计划。
- E 从共同祖先向前 24 个 commit，包含安全策略、审计、限流、session、分页、临时资源、Everything 完整性、依赖与测试结构加固。
- 两个仓库均为本地 `main`，没有 remote/upstream。
- D 仅有既存 `.serena/` 未跟踪内容；它不属于本次交付，不得加入任何 commit。
- E 工作树干净。

旧文件：

```text
codestable/roadmap/2026-08-19-merge-e-hardening-into-d/merge-plan.md
```

仍使用旧 HEAD，并主张保留未接入生产路径的 ProcessPool、继续打包 `es.exe`、机械合并文档等已经被本次讨论推翻的结论。本 roadmap 将直接替换旧文件，不保留重复副本。

E 的 `remaining-hardening` roadmap 曾有两个 `planned` 条目；它们已迁移到本 roadmap 并在旧位置标记为 `dropped`，避免重复执行入口：

- `contract-truncate-success`：原目标只是把大输出截断从错误改成成功，现由 M2 A+ 输出协议承载。
- `publish-es-optional`：原目标是把 `es.exe` 改成可选发布物，现由 M3 本地解析协议承载。

本 roadmap 不照搬旧实现：

- `contract-truncate-success` 升级为覆盖三个命令工具的 A+ 输出捕获、溢写与字符分页协议。
- `publish-es-optional` 固定为本地可选二进制解析，安装期、启动期和运行期均不下载。

最终目标是：

1. 以 D 为唯一主线，通过完整历史 merge 吸收 E 的已实现加固。
2. 保留 D 的 pwsh shell 选择、UTF-8 invocation 和 `file_info` 开关。
3. 用 A+ 替换 D/E 现有的大输出处理。
4. 完成 E 尚未落地的可选 Everything 发布边界。
5. 同步当前有效文档并通过完整验收。
6. 不配置 remote、不 push、不创建 PR。
7. E 目录由用户在验收后自行处理；Agent 不删除或移动 E 仓库。

## 2. 范围与明确不做

### 2.1 本 roadmap 覆盖

- 两条 Git 历史的 `--no-ff` 合并、冲突裁决、备份与回滚门禁。
- D 的 pwsh shell 选择、UTF-8 invocation 和 `file_info` 开关。
- E 的 hardBlock、命令 policy、SafeGuard、audit、rate limit、session、TempManager、分页及供应链加固。
- `execute_command`、`batch_execute`、`watch_command` 共用的 A+ 输出捕获实现。
- `.etmcp` 状态目录、旧状态迁移、分页缓存、TTL、LRU、总容量与崩溃恢复。
- `MCP_SECRETS_SCAN` 对命令输出的跨 chunk 扫描和 fail-closed 规则。
- `es.exe` 的可选本地安装、固定 SHA-256、原生搜索 fallback 和 npm 包排除。
- E 依赖基线、测试结构和零依赖 SDK patch。
- 当前有效文档同步、旧 roadmap 状态收口、最终 MCP server smoke。

### 2.2 明确不做

- 不使用 rebase、squash 或逐 commit cherry-pick 代替完整历史 merge。
- 不配置 remote，不 push，不建 PR。
- 不由 Agent 删除、移动或重命名 E 仓库。
- 不提交 D 中既有 `.serena/` 内容。
- 不升级 zod v4。
- 不继续支持 Node.js 18；最终运行基线为 Node.js `>=20.0.0`。
- 不激活或重新实现 ProcessPool；`pool_stats.active=false` 保持诚实。
- 不新增第 27 个以外的公开工具；分页读取复用 `execute_command`。
- 不新增独立 stderr 分页工具。
- 不把命令工具改成后台任务接口；首次响应始终等待真实退出或 watch 捕获窗口结束。
- 不引入 argv-only 执行模型或 OS sandbox。
- 不让 MCP server 在安装期、启动期或运行期下载 `es.exe`。
- 不迁移旧 `.enhanced-terminal-mcp\temp`。
- 不自动迁移全局 `%TEMP%\.enhanced-terminal-mcp-session.json`；该文件无法证明属于当前项目，只允许给出不泄露内容的人工迁移提示。
- 不改变 Unix/macOS 的 `/bin/sh -c` shell 路径。
- 不机械合并 README、ARCHITECTURE 或历史设计文档。

## 3. 模块拆分（概设）

```text
merge-e-hardening-into-d
├── M1 merge-and-runtime-base
│   └── 固定 Git 输入、完整历史合并、shell、安全、依赖与状态基线
├── M2 command-output-runtime
│   └── 三个命令工具共用的捕获、溢写、分页、secret 与临时资源协议
├── M3 optional-everything-runtime
│   └── es.exe 本地解析、完整性校验、fallback 与发布物裁剪
└── M4 documentation-and-acceptance
    └── 当前文档同步、旧计划收口、完整验证与本地交付
```

### 3.1 M1 · merge-and-runtime-base

- **职责**：建立可回滚的 Git 合并事务；完成 D shell 与 E hardening 的冲突裁决；统一依赖、错误转换、状态根和 tool surface。
- **不负责**：不在本模块完成 A+ 输出格式或 Everything 发布裁剪。
- **承载子 feature**：`merge-e-hardening-base`。
- **主要触点**：Git refs、`src/shell.ts`、`src/security.ts`、`src/command-policy.ts`、`src/result.ts`、`src/session.ts`、`src/state-dir.ts`、`src/pool.ts`、`package.json`、`package-lock.json`。

### 3.2 M2 · command-output-runtime

- **职责**：三个命令工具共享同一套字节捕获、backpressure、容量门禁、编码判定、字符索引、分页读取、secret 扫描和结构化响应。
- **不负责**：不改变命令 policy、SafeGuard 或 shell 选择优先级。
- **承载子 feature**：`command-output-spill-paging`。
- **主要触点**：`src/stream.ts`、`src/paging.ts`、`src/temp-manager.ts`、`src/tools/command.ts`、`src/result.ts`、相关 unit/e2e tests。

### 3.3 M3 · optional-everything-runtime

- **职责**：解析、验证并使用用户本地提供的 `es.exe`；不可用时提供明确 fallback 或安装提示；确保 npm 包不含二进制。
- **不负责**：不下载 Everything、不维护平台包、不为非 Windows 构造 Everything 等价物。
- **承载子 feature**：`publish-es-optional`。
- **主要触点**：`src/es-integrity.ts`、`src/tools/search.ts`、`package.json`、发布验证和文档。

### 3.4 M4 · documentation-and-acceptance

- **职责**：把最终实现同步到当前有效文档，关闭被迁移的旧 planned 条目，执行所有门禁并确认本地仓库可用。
- **不负责**：不删除 E 仓库、不配置 remote、不提前把失败 item 标为完成。
- **承载子 feature**：`post-merge-doc-sync-and-acceptance`。
- **主要触点**：README、AGENTS、CHANGELOG、ARCHITECTURE、相关 requirement/decision/roadmap、package dry-run、MCP smoke。

## 4. 模块间接口契约与共享协议

本节是四个子 feature 的硬约束。下游 design 如需改变可观察行为，必须先回到本 roadmap update。

### 4.1 固定 Git 输入与 merge 事务

执行前必须重新校验：

```text
D HEAD = 7eea8624934b313e4eb8cb40b7f8751df5297530
E HEAD = e28f2e997956480032ec59bd465738ad1a81feb6
共同祖先 = d4302243ae43f70b4bed8eb69600734c5c50e81f
```

任一 HEAD 或共同祖先变化，立即停止并重新 review，不把“只是多了一个文档 commit”视为可自动忽略。

固定命令：

```powershell
git branch backup/pre-merge-20260819 7eea8624934b313e4eb8cb40b7f8751df5297530
git fetch "E:\MCP 开发\Enhanced Terminal MCP" main:refs/heads/integration/e-main
git merge --no-ff --no-commit integration/e-main
```

门禁：

- 已存在的 `backup/pre-merge-20260819` 必须指向固定 D SHA；不允许强制改写。
- fetch 后 `integration/e-main` 必须等于固定 E SHA。
- fetch 后重新计算的 merge-base 必须等于固定共同祖先。
- merge 前记录 D 的预存未跟踪集合；最终不得把 `.serena/` 纳入 staged diff。
- 未经用户明确同意不得执行 `git commit`。
- 不执行 `git clean`。
- 备份分支、integration 分支和 E 仓库保留至最终验收完成。

回滚：

1. **merge 尚未提交**：使用 `git merge --abort`，再核对预存工作树状态。
2. **本地 merge commit 已生成但尚未被后续历史依赖**：只有再次得到用户明确确认后，才允许：
   ```powershell
   git reset --hard backup/pre-merge-20260819
   ```
3. **merge commit 已被后续 commit 依赖或交付给其他本地消费者**：
   ```powershell
   git revert -m 1 <merge_commit>
   ```
4. destructive rollback 前必须确认本 roadmap 新文件仍有非 C 盘可恢复副本或仍为安全未跟踪文件；不得让 `reset --hard` 恢复旧计划后留下两份有效 roadmap。

### 4.2 冲突裁决矩阵

总规则：

- shell 选择与 invocation 以 D 为准。
- 安全加固、audit、rate limit、session 与命令 policy 以 E 为准。
- 输出处理不直接采用任一旧实现，统一采用本 roadmap 的 A+。
- ProcessPool 采用 E 的 inactive stub。
- 依赖和测试结构采用 E 基线。
- 当前文档按最终实现重写，不机械取并集。
- 无法按这些规则安全裁决的冲突必须暂停，不允许自动选择 ours/theirs。

| 冲突区域 | 最终裁决 |
|---|---|
| `src/tools/command.ts` | D 的 `getShellSpec()` / `buildShellInvocation()` + E 的 precheck、audit、rateLimit、session + M2 的 A+ |
| `src/security.ts` | D 的 PowerShell 注入防护与 E 的间接执行、解释器、管道绕过规则取并集 |
| `src/command-policy.ts` | 保留 E 的 `blocklist`/`allow`、统一入口和 audit 分类；hardBlock 永远先执行 |
| `src/result.ts` | 保留 E 的统一错误体系，并修复 `isError:true` 时丢失机器可读 `structuredContent` 的问题 |
| `src/stream.ts` | D shell invocation + M2 字节流、backpressure、真实退出、UTF-8/GBK 处理 |
| `src/paging.ts` | 用 M2 的二进制字符索引和范围读取替换整文件加载 |
| `src/temp-manager.ts` | E 的 TTL/LRU 基础 + M2 的懒创建、容量、reservation、active lease |
| `src/state-dir.ts` | 使用固定 `projectRoot`、`.etmcp` 和本节迁移协议 |
| `src/session.ts` / `src/audit.ts` | 保留 E 的消毒、恢复、去抖和 audit；状态路径改为 `.etmcp` |
| `src/tools/search.ts` | D 的 shell spec + E 的完整性检查 + M3 的本地可选解析 |
| `src/utils.ts` | D 的 spawn-based `safeExec` + E 的 `envInt`；GBK fallback 只落在实际流式输出解码路径 |
| `src/pool.ts` / `pool_stats` | 采用 E inactive stub，结构化结果固定 `active:false` |
| `file_info` | 保留 D 的 `ENHANCED_TERMINAL_DISABLE_FILE_INFO` 开关 |
| package/lock | 采用 E 依赖基线；M3 再从发布 files 中移除 `es.exe` |
| tests | 采用 E 的 `tests/unit/` 结构，并补 D shell、file_info 与 M2/M3 新契约 |
| docs | 以最终代码为准重写当前文档；历史文档保留当时事实 |

### 4.3 shell 硬性契约

Windows 默认：

```text
MCP_SHELL=pwsh
```

`pwsh` 解析顺序：

```text
MCP_POWERSHELL_PATH
  → <runtime-root>\tools\pwsh\pwsh.exe
  → PATH 中的 pwsh.exe
  → Windows PowerShell 5.1
  → SHELL_NOT_FOUND
```

规则：

- `MCP_POWERSHELL_PATH` 是显式配置，必须为有效绝对文件路径并通过版本探测。
- 显式路径无效返回 `SHELL_PATH_INVALID`，不得继续 fallback。
- `MCP_SHELL=powershell` 只使用 system Windows PowerShell，不尝试 pwsh。
- `MCP_SHELL=cmd` 直接使用 `cmd.exe`。
- 未知 mode 返回 `INVALID_SHELL_MODE`。
- 解析结果成功或失败都做进程级缓存；修改环境变量、安装或替换 pwsh 后必须重启。
- pwsh 7 和 Windows PowerShell 5.1 在 invocation 层注入 UTF-8 preamble。
- cmd 保留 `chcp 65001`。
- Unix/macOS 继续 `/bin/sh -c`。
- `setup.bat → scripts/ensure-pwsh.ps1` 可以显式联网安装固定 pwsh 7.6.5；MCP server 运行期绝不联网。

### 4.4 安全、依赖与 tool surface 基线

命令执行顺序：

```text
input validation
  → checkCommandPolicy()
  → hardBlock / blocklist / allow
  → rate limit
  → SafeGuard
  → shell resolution
  → spawn
  → output capture
  → audit / structured result
```

约束：

- hardBlock 在 `strict`、`normal`、`off` 下均不可关闭。
- `MCP_COMMAND_POLICY=blocklist` 为默认。
- `MCP_COMMAND_POLICY=allow` 必须拒绝 shell 拼接、管道和嵌套 shell。
- `batch_execute` 在运行第一条命令前预检全部 command；任一预检失败时整批不得部分执行。
- E 的 batch rate mode 保留：
  ```text
  MCP_BATCH_RATE_MODE=batch | per_command
  ```
- tool surface 为 27 个工具；设置：
  ```text
  ENHANCED_TERMINAL_DISABLE_FILE_INFO=1
  ```
  后为 26 个。
- `pool_stats` 保留，但必须返回 `active:false`。

依赖固定为：

```json
{
  "engines": {
    "node": ">=20.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "zod": "^3.25.67"
  },
  "overrides": {
    "@modelcontextprotocol/sdk": "1.29.0"
  }
}
```

- SDK 保持精确版本和 override。
- zod 保持 v3，不顺手升级 v4。
- postinstall 只使用零 production dependency 的：
  ```text
  scripts/apply-mcp-sdk-patch.mjs
  ```
- `patch-package` 只能保留为 devDependency。
- Node 18 明确不受支持。

### 4.5 projectRoot、状态目录与迁移

server 启动时只计算一次：

```text
projectRoot = realpath(process.cwd())
```

在进程生命周期中不可变化。

默认状态目录：

```text
<projectRoot>\.etmcp
```

覆盖：

```text
MCP_STATE_DIR=<custom-state-root>
```

规则：

- 相对 `MCP_STATE_DIR` 只允许相对固定 `projectRoot` 解析一次，不能随 session cwd 漂移。
- `session_state set_cwd`、单条 command cwd、batch cwd、watch cwd 只影响命令执行位置。
- npm 包安装目录、源码目录和 `build/` 目录不得作为默认状态根。
- 设置 `MCP_STATE_DIR` 后不执行自动旧目录迁移。
- `.etmcp` 根可因 session 或 audit 按需创建，但 `temp` 仍保持独立懒创建。
- 当前有效文档统一使用 `.etmcp`；历史设计/acceptance 可保留旧名称。
- `.gitignore` 同时忽略 `.etmcp/` 和旧 `.enhanced-terminal-mcp/`，防止迁移残留进入 Git。

自动迁移源固定为：

```text
<projectRoot>\.enhanced-terminal-mcp
```

只处理：

```text
session.json
logs\audit.jsonl
```

不处理：

```text
temp\
其他未知文件
```

迁移事务：

- 首次使用 session/audit 前持有排他迁移锁。
- 不跟随 symlink、junction 或 reparse point。
- 迁移期间源文件的 size、mtime 或标识变化时中止。
- 使用同卷 staging、原子替换和回读验证。
- 任一步失败返回启动错误标识 `STATE_MIGRATION_FAILED`，保持源和已有目标不变。

`session.json`：

- 目标不存在、源有效：迁移并回读验证；成功后删除源。
- 目标已存在且有效：目标为权威，不合并、不覆盖；源保留，迁移记录标记 `skipped_target_exists`。
- 目标或待迁移源损坏：停止启动，不静默恢复为空 session，也不回退到另一份状态。

`audit.jsonl`：

- 目标不存在：原子迁移并验证。
- 新旧同时存在：旧记录在前、新记录在后，使用有界内存的流式精确去重；不得丢弃非重复记录。
- 合并成功并回读验证后才删除旧 audit。
- 编码或 JSONL 结构无法安全验证时停止，不覆盖任一原文件。

删除门禁：

- 永不迁移或删除旧 `temp`。
- 永不删除旧目录中的未知文件。
- 只删除已成功迁移并验证的源文件。
- 旧 `logs` 只在空时移除。
- 旧根只在完全为空时移除。
- 全局 `%TEMP%\.enhanced-terminal-mcp-session.json` 不自动导入或删除；发现时只记录不含内容、cwd 或 env 的提示。

### 4.6 A+ 共享输出捕获契约

三个工具必须调用同一个输出捕获实现：

```text
execute_command
batch_execute
watch_command
```

固定环境变量：

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `MCP_COMMAND_MEMORY_OUTPUT_BYTES` | `1048576` | stdout+stderr 在内存模式下的合计切换阈值 |
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | 可保留 stdout 上限，50 MiB |
| `MCP_COMMAND_MAX_STDERR_BYTES` | `1048576` | 可保留 stderr 上限，1 MiB |
| `MCP_TEMP_MAX_TOTAL_BYTES` | `1073741824` | 整个 temp 根的总容量，1 GiB |

这些配置进程级缓存，修改后需重启。无效整数或关系不成立时，命令在 spawn 前返回现有 `VALIDATION_ERROR`，不得静默改回默认值。

`MCP_COMMAND_MAX_OUTPUT_BYTES` 与 `MCP_COMMAND_MAX_STDERR_BYTES` 独立，避免 stdout/stderr 因事件到达顺序互相挤占。最大 retained 合计因此是 51 MiB。

状态机：

1. **内存模式**
   - stdout+stderr 保留量不超过 1 MiB。
   - 直接返回完整内存结果。
   - 不创建 `temp`、staging 或 `cache_id`。
   - 即使字符数超过默认 `pageSize=2000`，仍不为小输出自动落盘。

2. **溢写模式**
   - 首次真正超过 1 MiB 时才进入溢写准备；先通过 secret 扫描门，确认有可发布的安全前缀后才懒创建 staging。
   - 在未命中 secret 且 temp transaction 可用时，1 MiB 到各流上限之间完整写入缓存。
   - 首次响应仅返回 stdout 第 1 页和 stderr 诊断内容，并返回 `cache_id`。
   - 分页本身不等于截断；完整缓存存在时 `truncated=false`。

3. **达到保留上限**
   - stdout 超过 50 MiB 后停止保留 stdout，但继续 drain 和计数。
   - stderr 超过 1 MiB 后停止保留 stderr，但继续 drain 和计数。
   - 不因达到输出上限杀死进程。
   - 必须等待真实退出或命令超时处理完成。
   - 成功退出可返回 `ok:true, truncated:true`。
   - 非零退出或 timeout 仍保持其错误语义，并携带可用 `cache_id` 和诊断字段。

4. **scan-before-persist 安全门**
   - stdout/stderr 各自使用原始字节增量候选状态机；扫描门固定在 staging writer 之前，不依赖最终 UTF-8/GBK 判定。
   - `cache` / `strict` 从第一个字节开始扫描；`write` 仅在真正准备溢写时启动，并先重放仍在内存中的 retained 前缀；`off` 完全旁路命令输出扫描。
   - 每条流从最早未决候选起最多保留固定 `8192 bytes` quarantine。只有已证明不可能属于任何 secret 候选的安全前缀才可写入 staging。
   - 未决候选超过 8192 bytes 时按 secret fail-closed；该上限是不可配置的安全常量。两条流合计 quarantine 最多 16 KiB，候选状态数量也必须有固定上限。
   - quarantine 是 scanner 自有内存：位于 retained 前缀内的候选字节在 finalize 前只占用 provisional retained budget；安全释放后才进入最终 retained 统计，命中 secret 后按全量抑制规则归零。超过各流保留上限后的 drain-only 候选不计 retained；两者都不计 staging 实际字节或 reservation，释放到 writer 后不得重复计数。
   - scanner 一旦启用，即使达到保留上限、temp 容量不足或 staging 失败，也必须继续扫描 drain 数据；secret 判定优先于缓存降级。

5. **backpressure**
   - 写盘速度落后时必须使用 pause/resume、pipeline 或等价 backpressure。
   - 不允许把待写数据无界堆入 JS heap。
   - 输出达到保留上限后仍读取并丢弃后续字节，避免子进程因 pipe 填满而死锁。

6. **首次响应**
   - `execute_command` 等待退出或 timeout。
   - `batch_execute` 等待已调度命令结束。
   - `watch_command` 等待命令退出或 `duration` 捕获窗口结束。
   - 三者都不是后台 job API。

字节字段：

- `total_output_bytes`：实际收到的 stdout+stderr 字节总数。
- `retained_output_bytes`：仍可用于返回或缓存的 stdout+stderr 字节总数。
- `stdout_total_bytes` / `stderr_total_bytes`：各流实际收到的字节数。
- `stdout_retained_bytes` / `stderr_retained_bytes`：各流实际保留的字节数。
- `total_chars`：保留 stdout 按最终编码解码后的 Unicode code point 数。
- 保留上限正好截在多字节字符中间时，finalize 必须把 retained 尾部收缩到最后一个完整字符边界；actual 字节统计不受影响。

最终统计和降级预览固定按以下规则计算：

- `retained_*_bytes` 只表示调用结束后仍实际可返回或可从 cache 读取的原始命令输出字节；scanner/quarantine、fallback buffer、已删除 staging 等内部暂存不能直接计入。
- 任一启用 scanner 的 tier 命中 secret（含 8192-byte 未决候选 fail-closed）后，两个流都执行全量抑制：structured `stdout=""`、`stderr=""`，`stdout_retained_bytes=0`、`stderr_retained_bytes=0`、`retained_output_bytes=0`、`total_chars=0`、`paged=false`，且不返回 page 字段或 `cache_id`。固定占位说明只放在人类可读 `content`，不是命令输出，不计 retained；空 retained 流的 encoding 规范化为 `utf8`。`stdout_truncated` / `stderr_truncated` 分别等于对应 `*_total_bytes > 0`，`truncated=true`。
- 非 secret 情况下，捕获层从每条流的首个已由 scanner 证明安全的字节开始维护一个纯内存前缀缓冲；`off` tier 视所有字节为已证明安全。内部常量 `COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES=65536`，按 stdout/stderr **每流**生效、不可配置，且不会触发状态目录或 temp 创建。
- temp 容量、锁或 writer 失败后，只能从上述安全前缀生成 fallback preview：stdout 最多返回 effective `pageSize` 个 Unicode code point（未提供时 2000），stderr 最多返回缓冲中 65536 个原始字节解码后的完整字符；两流都先收缩到完整字符边界。`retained_*_bytes` 和 `total_chars` 只统计最终实际返回的原始预览，`paged=false`、无 page 字段和 `cache_id`，各流 `*_truncated` 按 actual 与 retained 比较，`truncated=true`。64 KiB 足以覆盖允许的最大 10000-code-point UTF-8 stdout 首页及 BOM，同时把额外内存固定在两流合计 128 KiB。
- 若后续扫描命中 secret，必须清空两个 fallback buffer，并以上述 secret 全量抑制规则覆盖先前的 temp 降级候选；不得返回已经证明安全的另一条流作为旁路。

统一机器可读结果：

```ts
type CacheDisabledReason =
  | "secret_detected"
  | "temp_capacity_exceeded"
  | "temp_unavailable";

interface CommandOutputEnvelope {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  paged: boolean;

  total_output_bytes: number;
  retained_output_bytes: number;
  stdout_total_bytes: number;
  stdout_retained_bytes: number;
  stderr_total_bytes: number;
  stderr_retained_bytes: number;
  total_chars: number;

  stdout_encoding: "utf8" | "gbk";
  stderr_encoding: "utf8" | "gbk";

  cache_id?: string;
  page?: number;
  total_pages?: number;
  page_size?: number;
  cache_disabled_reason?: CacheDisabledReason;

  capture_limit_reached?: boolean;
  error?: StructuredError;
}
```

约束：

- `truncated=true` 仅表示字节被丢弃、secret 策略禁止返回，或缓存失败后只能保留安全预览。
- 仅仅返回第一页时使用 `paged=true`，不把它误报为 truncated。
- `stderr` 没有独立分页入口，最多返回保留的 1 MiB 诊断内容，并用 `stderr_truncated` 表明是否还有未保留内容。
- 人类可读 `content` 必须简短；完整状态放在 `structuredContent`。

错误转换必须修正为：

```text
isError: true
structuredContent:
  ok: false
  error:
    code
    message
    retryable
    suggestion?
    param?
    detail?
  ...可用的 CommandOutputEnvelope 诊断字段
```

不得再像 E 当前实现一样在 `toCallToolResult()` 中丢弃 `error.detail`。

### 4.7 三个命令工具的差异化响应

#### `execute_command`

执行模式：

```ts
execute_command({
  command: string,
  cwd?: string,
  timeout?: number,
  pageSize?: number
})
```

分页读取模式：

```ts
execute_command({
  cache_id: string,
  page?: number,
  pageSize?: number
})
```

规则：

- `command` 与 `cache_id` 必须严格二选一。
- 两者同时存在或同时缺失：`VALIDATION_ERROR`。
- command 执行模式不得传 `page`；新命令不能直接索取后续页。
- command 执行模式可传 `pageSize`，仅在实际溢写时决定首次页大小。
- cache 读取模式只允许 `cache_id`、`page`、`pageSize`。
- cache 读取模式附带 command、cwd 或 timeout：`VALIDATION_ERROR`，不得静默忽略。
- 非零退出：`EXECUTION_FAILED`，`isError:true`，保留诊断 envelope。
- timeout：`TIMEOUT`，`isError:true`，保留诊断 envelope。
- cache 读取成功时，当前读取调用使用 `isError:false`；若原命令非零退出或 timeout，envelope 仍原样保留 `ok:false`、原 `error`、`exit_code` 和 `timed_out`。读取基础设施错误才把当前调用标成 `isError:true`。

#### `batch_execute`

- 每个 command 使用独立捕获状态、独立字节统计和独立 `cache_id`。
- 不把整批 stdout 合成一个缓存。
- 某个 command 非零退出或 timeout 时，该 result 的 `ok=false` 并附带 error。
- batch 使用有界 work queue：顺序模式并发 1，parallel 模式并发固定 4；不得按 4 条一批等待后再调度下一批。
- `results` 始终与输入 commands 等长并按输入顺序排列；每项带稳定 `index` 和 `status: completed|skipped`。未调度项使用 `status: skipped`、`skip_reason: stop_on_error`，不伪造 exit/output/cache。
- `status: skipped` 是“未创建子进程”的独立 union 分支，只有 `index`、原输入 `command`、`status` 和 `skip_reason`；不带 `ok`，也不带 latency、exit、timeout、output、统计或 cache 字段。调用方必须先按 `status` 判别。
- `stop_on_error=true` 在任一模式都只阻止失败被观察后尚未调度的命令；已经 active 的命令必须正常收尾。`stop_on_error=false` 调度全部命令。
- 顶层返回 `results`、`all_ok`、`completed`、`failed`、`skipped` 和 summary；固定不变量为 `completed + skipped = commands.length`、`failed = completed results 中 ok=false 的数量`、`all_ok = failed === 0 && skipped === 0`。单条失败不丢失其他结果。单条 strict secret 命中是该 result 的 `SECRET_DETECTED`，不是顶层基础设施失败。
- 保持现有空数组兼容：`commands=[]` 不 spawn、不创建 temp、不消耗 per-command token，返回 `results=[]`、`completed=0`、`failed=0`、`skipped=0`、`all_ok=true`；batch 级 policy/SafeGuard/rate-limit 的既有调用边界不在本 feature 中另行改变。
- policy、SafeGuard 或顶层基础设施在执行前失败时，整个 tool 才返回 `isError:true`。

#### `watch_command`

- 每次调用最多产生一个 `cache_id`。
- `duration` 到期是 watch 的正常捕获窗口结束：
  ```text
  ok=true
  timed_out=false
  capture_limit_reached=true
  ```
- duration 到期后按现有温和终止→强制终止策略等待子进程关闭。
- 若强制终止后子进程仍未确认关闭，返回 `EXECUTION_FAILED`、detail=`watch_termination_failed`；保留已捕获的安全诊断，且 `timed_out=false`、`capture_limit_reached=true`。
- 在 duration 前非零退出仍为 `EXECUTION_FAILED`。
- 输出达到保留上限不改变 watch 的捕获窗口语义。
- 调用仍等待窗口结束或真实退出，不返回后台句柄。

### 4.8 分页读取和 `cache_id`

所有三个命令工具产生的缓存统一通过 `execute_command({cache_id,...})` 读取。

- 分页读取不重新执行命令。
- 不进入命令 policy、SafeGuard 或 command rate limit。
- `page` 从 1 开始，默认 1。
- `pageSize` 按 Unicode code point 计数，默认 2000，最大 10000。
- 后续读取改变 `pageSize` 时重新计算页边界和 `total_pages`，不重写缓存。
- `stderr` 只在首次响应和 cache `page=1` 返回；`page>1` 固定返回 `stderr=""`，但 stderr 字节统计、encoding 和 truncated 字段仍保持完整。调用方可用同一 `cache_id` 重读 page 1 取回 retained stderr。
- 非法、已过期或不存在的 `cache_id`：`PATH_NOT_FOUND`。
- 合法缓存但 page 越界：`VALIDATION_ERROR`，机器可读 detail 包含 `total_pages`。
- 只有成功读取才刷新滑动 TTL。
- 读取 audit action：
  ```text
  command.output.read
  ```
  只记录 cache_id、页码、读取字符/字节数，不记录 command、cwd 或输出内容。

`cache_id` 格式：

```text
page-cache-<13位毫秒时间戳>-<128-bit小写hex随机数>
```

示例正则：

```regex
^page-cache-\d{13}-[0-9a-f]{32}$
```

随机数必须来自 `node:crypto`，不得使用 `Math.random()`。

读取时同时验证：

- ID 格式。
- 词法路径仍位于 temp root。
- `lstat` 不为 symlink/junction/reparse point。
- 最终规范化路径仍位于固定 temp root。
- `meta.json`、索引和文件大小相互一致。

### 4.9 分页文件、编码和字符索引

最终缓存目录：

```text
<state-dir>\temp\page-cache-<timestamp>-<random>\
├── stdout.bin
├── stderr.bin
├── stdout.idx
└── meta.json
```

写入期使用不可读取的 staging：

```text
<state-dir>\temp\inflight-page-cache-<timestamp>-<random>\
```

`stdout.bin` / `stderr.bin`：

- 保存实际保留的原始字节前缀。
- `stdout.bin` 可保留 UTF-8 BOM，但 BOM 不出现在分页正文。
- 多字节尾部必须收缩到完整字符边界。

`meta.json` 只允许保存：

- schema version、`complete:true`、cache_id。
- stdout/stderr encoding。
- stdout data start。
- exit code、timed_out、capture limit、截断状态。
- 各流和合计字节统计、`total_chars`、默认 page size。
- created/last-accessed 时间。

不得保存：

- 完整 command。
- cwd。
- stdout/stderr 文本副本。
- 环境变量。
- secret finding 原文。

`stdout.idx` 使用版本化二进制格式：

```text
Header（16 bytes）
├── magic          8 bytes   ASCII "ETMCPIDX"
├── version        uint16LE  1
├── encoding       uint8     1=utf8, 2=gbk
├── flags          uint8     0
└── stride_chars   uint32LE  1024

Record（每条 16 bytes）
├── char_offset    uint64LE
└── byte_offset    uint64LE
```

索引规则：

- 第一条为 `(0, stdout_data_start)`。
- 每 1024 个 Unicode code point 生成检查点。
- 最终哨兵为 `(total_chars, stdout_retained_bytes)`。
- 空 stdout 只有一条 `(0, stdout_data_start)`，不重复写同值哨兵。
- byte offset 必须位于完整字符边界。
- offsets 单调不减，最终哨兵必须与 meta/file size 一致。
- `uint64` 读写使用 BigInt；转换为 JS number 前验证不超过安全整数范围。
- stderr 不建立字符索引。

字符语义：

- 中文字符计 1。
- 单个补充平面 emoji 计 1，不按两个 UTF-16 code unit 计数。
- 不做 grapheme cluster 分割；组合附加符和 ZWJ 序列允许跨页。
- 不做 Unicode normalization。
- `\r\n` 保持原样并计两个 code point。
- 页边界：
  ```text
  start_char = (page - 1) * pageSize
  total_pages = max(1, ceil(total_chars / pageSize))
  ```

编码判定：

- 有 UTF-8 BOM：固定 UTF-8，分页时剥离 BOM；非法序列替换为 `U+FFFD`。
- 无 BOM 且完整 retained 内容为合法 UTF-8：UTF-8。
- Windows 无 BOM 且 UTF-8 非法：使用 `TextDecoder("gbk")`，非法序列替换为 `U+FFFD`。
- Unix/macOS：固定 UTF-8，非法序列替换为 `U+FFFD`。
- stdout 和 stderr 独立判定，避免一条流污染另一条流的编码结论。
- 命令结束后以固定大小 chunk 对最多 50 MiB stdout 做一次顺序扫描，辅助内存不得随文件大小增长；统一完成编码判定和索引，不维护易失效的实时 UTF-8 临时索引，也不得一次加载整个 stdout。
- 翻页先二分查找最近检查点，再从对应 byte offset 增量解码；不得加载整个 `stdout.bin`。

索引或 meta 损坏时：

- 不猜测编码。
- 不退化为整文件读取。
- 返回 `EXECUTION_FAILED`，detail 标记 `cache_corrupt`。
- 不刷新 TTL。
- 将该缓存交给安全 cleanup，不递归删除 temp root 外任何内容。

### 4.10 缓存原子发布、并发和崩溃恢复

发布顺序：

1. 按 4.12 初始化 scanner；`cache` / `strict` 从首字节扫描，`write` 在首次溢写准备时先扫描内存前缀，`off` 旁路。
2. 只有 scanner 已释放安全前缀且确实需要溢写时，才 cleanup、申请初始 reservation 并创建 staging。
3. 后续 retained 字节先进入 scanner；writer 只接收已证明安全的前缀，未决 quarantine 和已命中 secret 的字节永不写入 staging。
4. 流结束时解析未决候选；安全才释放 quarantine，命中或超过 8192 bytes 则执行对应 secret 策略。
5. 确定编码并以固定大小 chunk 顺序生成 `stdout.idx`。
6. 最后生成 `meta.json`，标记 `complete:true`。
7. flush/close 所有句柄，并移除 staging 内 heartbeat/lease 等控制文件；最终 cache 目录只允许四个 4.9 文件。
8. 在同一 temp root 内原子 rename 为最终 `page-cache-*`。
9. rename 成功后才向调用方暴露 `cache_id`。

任一步失败：

- 不暴露 cache_id。
- 删除当前 staging。
- 继续 drain 已启动命令并等待真实结果。
- 未命中 secret 时，按 4.6 的 `COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES=65536` 每流安全前缀规则生成预览；`retained_*_bytes` 只统计最终实际返回的预览，不把已删除 staging 或内部缓冲中未返回的字节算作 retained。
- 返回安全预览以及：
  ```text
  truncated=true
  cache_disabled_reason=temp_unavailable
  ```
- 不把缓存失败伪装成命令退出失败。

容量并发：

- 同进程使用 async mutex 管理目录状态和 reservation。
- 跨进程容量变更使用 temp root 下的短期排他锁。
- reservation 采用增量分配，不一次保守占满 51 MiB；每次扩展必须在锁内重新核算容量。
- 全局有效用量：
  ```text
  completed_actual_bytes
  + active_reserved_bytes
  + 其他 temp 实际字节
  ```
- staging 实际字节已包含在 reservation 中，不重复计数。
- 无法扩展 reservation 时停止持久化并按 `temp_capacity_exceeded` 降级。
- lock 无法安全取得时按 `temp_unavailable` 降级，不阻塞命令 drain。

崩溃恢复：

- staging 和 reservation 带周期性 heartbeat lease。
- cleanup 只能删除 lease 已过期且未被当前进程标记 active 的 staging。
- server 启动时仅在 temp 已存在的情况下扫描恢复，不为扫描创建 temp。
- cleanup、容量变更与分页读取共享同一跨进程锁协议；分页读取只在校验、范围读取和 touch 的短临界区持锁，不在最终 cache 目录留下 lease 文件。锁超时在执行/发布路径降级为 `temp_unavailable`，在 cache 读取路径返回 retryable `EXECUTION_FAILED` + detail=`cache_lock_timeout`。
- Windows 下删除失败应保留条目并记录 warning，不能把 Map 状态误报为已删除。

### 4.11 TempManager、TTL、LRU 和容量

固定默认值：

```text
MCP_TEMP_TTL_MS=3600000
MCP_MAX_TEMP_DIRS=100
MCP_TEMP_CLEANUP_INTERVAL_MS=300000
MCP_TEMP_MAX_TOTAL_BYTES=1073741824
```

规则：

- 总容量约束整个 `<state-dir>\temp`，不只约束 page cache。
- TTL 为滑动过期：发布完成开始计时，成功翻页刷新 `last_accessed_at`。
- 非法 cache_id、越界页和读取失败不得刷新。
- cleanup 固定顺序：
  1. 删除过期且非 active 的受管目录。
  2. 若仍超过受管目录数上限，按 LRU 删除。
  3. 若仍超过总容量，继续按 LRU 删除，直到满足容量。
- 未知目录计入容量，但不得自动删除；无法腾出空间时宁可禁用新缓存。
- 正在写入、发布或读取的缓存不得删除。
- 首次超过内存阈值时先 cleanup 并申请初始 reservation。
- 发生容量不足时：
  - 删除半成品。
  - 保留有界、安全的内存预览。
  - 继续 drain。
  - 不生成 cache_id。
  - 命令最终 ok/exit/timeout 由真实结果决定。

懒创建：

- 设置工作目录不得创建 temp。
- server 启动且不存在旧 temp 时不得创建 temp。
- 配置加载、小输出命令、`temp_stats` 不得创建 temp。
- cleanup 在目录不存在时直接返回零结果。
- 只有实际进入 `TempManager.create()`、输出溢写或其他明确临时资源路径时才创建。

`temp_stats` 至少返回：

```ts
{
  total_dirs: number;
  total_size_bytes: number;
  active_dirs: number;
  reserved_bytes: number;
  oldest_dir_ms: number;
  newest_dir_ms: number;
  removed_count: number;
}
```

temp 不存在时所有字段为零。

### 4.12 command output secret 策略

沿用：

```text
MCP_SECRETS_SCAN=off|write|cache|strict
```

默认：

```text
cache
```

命令输出扫描必须同时覆盖 stdout 和 stderr，支持任意 chunk 切分，不受旧 4 MiB 单次扫描上限影响。实现使用共享 pattern registry，`scanContent` 的 whole-string regex 与命令输出的流式 matcher 不得维护两份可独立漂移的 secret 定义。

流式 matcher 固定契约：

- stdout/stderr 独立维护原始字节候选状态；ASCII anchor、边界和字符类按现有 pattern 语义匹配，高位字节按可能的 UTF-8/GBK 字符作保守分支，scanner 不等待最终 encoding 才工作。
- 从最早未决候选开始保留 quarantine；无候选的安全前缀立即释放，已证明失败的候选从状态集中移除。状态数和回溯均有固定上限，不允许把全部输出保存在 scanner 中。
- 每条流 quarantine 固定上限 `8192 bytes`，不可通过环境变量调大或关闭。候选在上限内保持精确/保守匹配；仍未决而将超过上限时直接判定 secret，fail-closed。
- EOF 是有效边界：结束时必须解析短候选；满足模式则命中，不满足则释放。不得因 chunk 尾部、BOM、无效 UTF-8 或最终选择 GBK 而漏掉 ASCII credential。
- scanner 是 pattern registry 的保守超集：允许在编码歧义或超长未决候选时产生安全侧 false positive，不允许对 registry 可匹配的输入产生 false negative。
- 只有 scanner 已释放的安全字节才可进入 staging。quarantine、命中内容及其后续字节都不得先落盘再删除；不新增运行时依赖。

行为：

- `off`
  - 命令输出不扫描。
  - 仍受其他 hardBlock、路径和 SafeGuard 约束。

- `write`
  - 保留现有 `write_file` 写入防护。
  - 命令输出只有在真正准备持久化时启动流式扫描；必须先扫描仍在内存中的 retained 前缀，再决定是否创建 staging。
  - 发现 secret 后立即停止持久化、删除仅含已证明安全前缀的 staging、不生成 cache_id；命中原文从未进入 staging。
  - structured stdout/stderr 与 retained 统计按 4.6 全量归零；固定安全占位只放在人类可读 `content`。命令退出状态不因此改变，并设置 `cache_disabled_reason=secret_detected`。

- `cache`（默认）
  - 包含 write 规则。
  - 从首字节扫描全部命令输出，包括内存小输出、超过 4 MiB 的输出、停止保留后的 drain 数据，以及 temp 容量/锁降级后的后续数据。
  - 发现 secret 时不返回原始输出、不生成 cache_id：
    ```text
    cache_disabled_reason=secret_detected
    truncated=true
    ```
  - 命令本身不因 secret 被判定失败。
  - structured stdout/stderr 与 retained 统计按 4.6 全量归零；固定安全占位只放在人类可读 `content`。

- `strict`
  - 从首字节扫描全部输出，范围与 cache 相同。
  - 发现 secret 后拒绝输出、删除 staging、不留分页文件。
  - 返回公共错误码：
    ```text
    SECRET_DETECTED
    ```
  - `isError:true`、`cache_disabled_reason=secret_detected`；structuredContent 的 stdout/stderr 与 retained 统计按 4.6 全量归零，只保留 actual 非敏感字节统计、真实 exit/timeout 事实和结构化错误。

secret 安全响应只允许在人类可读 `content` 使用固定占位文本，并在 structuredContent 保留非敏感统计；不得保留匹配文本、前后文、command、cwd 或任何原始 stdout/stderr。temp 降级但最终未命中 secret 时，才允许返回 4.6 定义的有界安全原始预览。

secret 策略优先于容量降级：scanner 一旦按 tier 启用，容量不足、锁失败或 writer 失败后仍要继续扫描 drain 数据，不能以“不再写盘”为由跳过扫描。命中后可停止 pattern 计算，但仍必须 drain 并完成 actual 字节计数。

### 4.13 Everything 可选本地解析与发布协议

固定 SHA-256：

```text
5101b3a6d9542de378e077f4b8c66c4e608d3bff088092427749b65fbb18b342
```

解析顺序：

```text
ENHANCED_TERMINAL_ES_PATH
  → <state-dir>\tools\es.exe
  → unavailable
```

规则：

- 显式 `ENHANCED_TERMINAL_ES_PATH` 优先级最高。
- 显式路径不存在、不是文件、无法读取或 hash 不匹配时 fail-closed，不尝试第二路径。
- 未设置显式路径时检查 `<state-dir>\tools\es.exe`。
- state 路径缺失或 hash 不匹配时拒绝执行该 binary。
- 两个来源都必须使用同一固定 SHA-256。
- 解析结果可按进程缓存，但每次执行前检查文件 fingerprint；size/mtime/file-id 变化时必须重新 hash。
- 不读取仓库内 `es_tool/es.exe` 作为生产路径。
- 源码仓库可保留 `es_tool/es.exe` 作为开发或测试夹具。
- npm package 的 `files` 不得包含 `es_tool/es.exe`。
- 安装期、postinstall、启动期和运行期均不得下载二进制。

工具差异：

- `search_files`
  - 未显式配置且本地 binary 不可用时自动使用原生搜索 fallback。
  - 显式路径错误时返回结构化配置错误，不能静默掩盖错误配置。

- `everything_search`
  - binary 不可用时返回现有错误体系下的结构化失败。
  - detail 至少包含：
    ```text
    reason
    expected_sha256
    env_name=ENHANCED_TERMINAL_ES_PATH
    default_path=<state-dir>\tools\es.exe
    download_performed=false
    ```
  - 不在错误处理中提供自动下载动作。

## 5. 子 feature 清单

### 5.1 `merge-e-hardening-base`

- **描述**：以固定 commit 完成可回滚的完整历史 merge，并形成 D shell、E hardening、E 依赖和 `.etmcp` 状态基线。
- **所属模块**：M1。
- **依赖**：无。
- **状态**：done（2026-08-19 验收通过）。
- **对应 feature**：2026-08-19-merge-e-hardening-base。
- **最小闭环**：是。
- **完成后可观察结果**：
  - D main 同时包含两条历史。
  - 普通 Windows 命令通过 D 的 pwsh 契约执行。
  - E hardBlock、policy、audit、rate limit、session 生效。
  - `pool_stats.active=false`。
  - tool count 为 27/26。
  - Node、SDK、zod 和 postinstall 基线固定。
  - merge 冲突全部有明确裁决和测试证据。

### 5.2 `command-output-spill-paging`

- **描述**：为三个命令工具建立共享 A+ 捕获、溢写、字符分页、secret、容量和结构化错误协议。
- **所属模块**：M2，并消费 M1 的 shell、result、state 和安全基线。
- **依赖**：`merge-e-hardening-base`。
- **状态**：done（2026-08-21 验收通过）。
- **对应 feature**：2026-08-20-command-output-spill-paging（design 已 approved）。
- **已完成**：
  - `src/capture.ts`：原始 stdout/stderr 字节捕获、actual 计数、backpressure、drain、timeout、watch window、终止失败和消费失败 fail-closed；每流 chunk 顺序保证。
  - `src/command-output.ts`：三个 handler 共享的 A+ workflow——进程级输出上限解析、纯内存保留、超限继续 drain、scan-before-persist、8192-byte quarantine、双流 secret 抑制、65536-byte fallback preview、staging finalize 和完整 envelope；Windows 无 BOM 且非法 UTF-8 按 GBK 解码。
  - `src/paging.ts`：page cache v2 四文件（`stdout.bin`/`stderr.bin`/`stdout.idx`/`meta.json`）、版本化二进制字符索引、范围读取、四重校验和 staging 原子发布。
  - `src/temp-manager.ts`：懒创建、增量 reservation、同进程 mutex、跨进程短锁、staging heartbeat lease、崩溃恢复、TTL/LRU 双维清理和 `active_dirs`/`reserved_bytes`。
  - `src/result.ts`：`SECRET_DETECTED`、`CommandOutputEnvelope`、`BatchCommandResult`、`CacheDisabledReason` 及对应公开 schema。
  - `src/tools/command.ts`：execute_command 严格双模式、batch 并发 1/4 work queue 与 completed/skipped union、watch window/termination、cache read `isError` 差异和 `command.output.read` audit。
  - `src/secret-registry.ts` / `src/secret-stream.ts`：whole-string 与流式 matcher 的共享 pattern 来源，8192-byte quarantine 和差分/属性测试。
- **完成后可观察结果**（已达成）：
  - 小输出不落盘。
  - 中等输出完整分页。
  - 超限输出继续 drain 并正确标记。
  - error/timeout 保留机器可读诊断和 cache_id。
  - GBK、Unicode code point、backpressure、TTL/LRU、容量和 secret 模式均有回归证据。
  - cmd/powershell/pwsh 三链路 `echo 中文测试` 一致。

### 5.3 `publish-es-optional`

- **描述**：将 Everything CLI 改为固定 hash 的本地可选依赖，并从 npm 发布物中移除二进制。
- **所属模块**：M3。
- **依赖**：`command-output-spill-paging`。
- **状态**：done（2026-08-22 验收通过；S1–S5 resolver、fingerprint/hash、搜索契约、npm 发布裁剪、全量门禁与 feature checks 全部完成）。
- **对应 feature**：2026-08-21-publish-es-optional。
- **完成后可观察结果**：
  - 显式路径和 state 路径可校验使用。
  - 错误显式配置 fail-closed。
  - `search_files` 可原生 fallback。
  - `everything_search` 给出结构化安装提示。
  - `npm pack --dry-run` 不含 `es.exe`。
  - 全生命周期无下载逻辑。

### 5.4 `post-merge-doc-sync-and-acceptance`

- **描述**：把最终实现同步为唯一当前文档口径，关闭旧计划，并执行完整本地发布验收。
- **所属模块**：M4，覆盖 M1～M3。
- **依赖**：`publish-es-optional`。
- **状态**：done（2026-08-22 最终本地收口完成）。
- **对应 feature**：无（roadmap final closure）。
- **完成后可观察结果**：
  - 当前 README、AGENTS、ARCHITECTURE、CHANGELOG、requirements/decisions 与代码一致。
  - E `remaining-hardening` 的两个旧 planned 条目不再形成重复计划。
  - 新 roadmap 四个 item 均有 acceptance 证据。
  - package、MCP smoke、全量测试和 Git hygiene 全部通过。
  - E 仓库仍由用户自行决定是否删除。

## 6. 排期与依赖理由

执行顺序固定：

```text
merge-e-hardening-base
  → command-output-spill-paging
  → publish-es-optional
  → post-merge-doc-sync-and-acceptance
```

理由：

1. M1 先建立唯一 shell、安全、依赖、状态和 Git 历史基线，避免后续 feature 在两条分支重复实现。
2. M2 依赖 M1 的 result、session、audit、TempManager 和命令工具入口。
3. M3 技术上可部分独立，但固定后置可以先稳定状态根，再定义 `<state-dir>\tools\es.exe`。
4. M4 必须最后执行，因为 architecture 和用户文档只记录最终现状，不记录中间状态。

最小闭环是第 1 项：它完成后，D 主线已能以 pwsh 执行真实命令，同时具备 E 的核心 hardening；后续三项是在该可运行基线上完成输出、发布和交付收口。

## 7. 验证门禁

任何失败都不得把对应 item 标为 `done`。

### 7.1 阶段 A：Git 与环境 preflight

- 核对三个固定 commit。
- 核对 D 仅有允许的 `.serena/` 未跟踪内容。
- 核对 E 工作树干净。
- 核对 backup/integration ref 未被错误复用。
- 核对 Node.js `>=20.0.0`。
- 所有可控 TEMP、TMP、npm cache、测试临时目录指向已确认的非 C 盘路径。
- 不运行 remote、push 或 PR 命令。

### 7.2 阶段 B：merge/base 门禁

必须全部通过：

```text
npm install
npm run build
npx tsc --noEmit
npm run lint
npm test
npm run test:latency
git diff --check
```

专项验证：

- 默认 pwsh：显式路径→bundled→PATH→5.1→`SHELL_NOT_FOUND`。
- 显式错误路径 fail-closed。
- `MCP_SHELL=powershell|cmd`。
- UTF-8 preamble 和 cmd `chcp 65001`。
- hardBlock 在 strict/normal/off 全模式不可绕过。
- allow policy、元字符拒绝、batch 全量 precheck。
- file_info 开关下 27/26 工具。
- `pool_stats.active=false`。
- state root 不随 session cwd 漂移。
- session/audit 迁移正常、目标冲突、损坏和并发场景。

### 7.3 阶段 C：A+ 输出门禁

阈值边界：

- 空输出。
- 小于、等于、刚超过 1 MiB。
- 等于、刚超过 stdout 50 MiB。
- 等于、刚超过 stderr 1 MiB。
- stdout/stderr 同时高流量。

行为：

- 小输出不创建 temp/cache。
- 中等输出完整分页，首次响应只含第 1 页。
- 超限继续 drain，等待真实退出。
- 成功截断、非零退出、timeout、watch duration、watch 终止失败、batch stop/parallel 有界队列与 skipped 行。
- 空 batch 返回长度/计数全零且 `all_ok=true`；skipped 分支不含 `ok` 或任何伪造进程字段，`completed + skipped = commands.length`。
- error 的 `structuredContent` 保留 detail、统计和 cache_id。
- cache 读取原失败命令时当前调用 `isError:false`，envelope 仍保留原失败；cache 本身读取失败时 `isError:true`。
- 新 command 与 cache read 参数互斥。
- cache_id 不重跑命令、不消耗 command rate token。
- 非法 ID、路径穿越、junction、越界页和损坏索引。
- page 1 可重复取得 retained stderr；page>1 的 stderr 为空且统计不丢失。

编码与索引：

- UTF-8、UTF-8 BOM、无效 UTF-8、GBK。
- 多字节字符跨 chunk。
- emoji、组合字符、ZWJ 序列和 CRLF 页边界。
- 改变 `pageSize` 后页边界重新计算。
- 范围读取不整文件加载。

资源：

- 慢写盘 backpressure。
- 输出超过保留上限后内存不随 actual output 线性增长。
- 通过降低测试配置模拟 1 GiB 容量门禁。
- temp 容量/锁/writer 降级只返回每流最多 65536-byte 安全前缀；stdout 受 effective `pageSize` 字符上限约束，retained 统计只计实际返回预览。
- TTL、成功读取 touch、非法读取不 touch。
- LRU 数量和容量清理。
- active 目录、并发 reservation、崩溃 staging 恢复。
- `temp_stats` 和 cleanup 不创建缺失 temp。

secret：

- off/write/cache/strict。
- stdout/stderr。
- 每个 pattern 在每个可能字节边界切分时仍能命中；whole-string regex 与流式 matcher 做差分/属性验证。
- quarantine 8191/8192/8193 bytes、EOF 未决候选、编码歧义和超长候选 fail-closed。
- 超过 4 MiB 后仍扫描。
- secret 与容量不足同时发生时，secret 策略优先。
- strict 只返回 `SECRET_DETECTED` 和非敏感统计。
- write/cache/strict 命中后 structured stdout/stderr 为空，全部 retained 统计和 `total_chars` 为零；占位 `content` 不计命令输出，两个 fallback buffer 均被清空。
- fault injection 在 scanner、writer、reservation、finalize 和 rename 各阶段中断后，staging/meta/audit 均不含 secret 原文；最终 cache 始终只有四个文件。
- meta/audit 不保存输出或 secret 上下文。

### 7.4 阶段 D：Everything 与 package 门禁

- 有效 `ENHANCED_TERMINAL_ES_PATH`。
- 显式路径不存在、非文件、hash mismatch。
- 有效 `<state-dir>\tools\es.exe`。
- state binary 缺失或 hash mismatch。
- resolver 不读取 `es_tool/es.exe` 生产路径。
- `search_files` 原生 fallback。
- `everything_search` 结构化安装提示。
- fingerprint 变化触发重新 hash。
- 安装、启动、运行路径无下载调用。
- `npm pack --dry-run` 输出不含 `es.exe`。

### 7.5 阶段 E：最终验收

再次执行：

```text
npm install
npm run build
npx tsc --noEmit
npm run lint
npm test
npm run test:latency
npm pack --dry-run
git diff --check
```

并完成：

- 启动最终 MCP server。
- `tools/list` 验证 27/26。
- 实际调用三个命令工具的正常、分页和错误路径。
- 实际调用 `temp_stats`。
- 实际调用有/无 Everything 的搜索路径。
- 核对 stderr 未污染 stdio 协议。
- 核对最终 Git status、staged 范围和 `.serena/` 排除。
- 不 push、不配置 remote。
- 用户未明确同意时不 commit。

## 8. 文档同步规则

M2 A+ 实现与验收已完成；在 M3 实现与验收完成前，不把 M3 目标态字段写入 architecture 或 requirements。M4 负责把 M2/M3 最终事实统一回写当前文档。

M4 按以下规则同步：

### 当前有效文档

必须按最终代码重写：

- `README.md`
- `AGENTS.md`
- `CHANGELOG.md`
- `codestable/architecture/ARCHITECTURE.md`
- `codestable/requirements/powershell-default-shell.md`（仅最终行为确有变化时）
- package metadata 和 `.gitignore`
- 当前仍被引用的 state/temp/paging/Everything decision

2026-08-22 已完成 M4 最终同步：README、AGENTS、ARCHITECTURE、Everything requirement、active decision、package metadata 和 feature acceptance 已与最终代码一致；`build/` 采用 build 前清理，最终 package 和 MCP smoke 已通过。

必须统一：

- Node `>=20.0.0`
- SDK `1.29.0`
- zod v3
- 27/26 工具
- inactive ProcessPool
- `.etmcp`
- A+ 三工具契约
- Everything 本地可选、零下载
- D shell fallback 顺序

### 历史文档

- 已完成 feature、issue、acceptance 和旧设计保留当时事实。
- 历史文档可以继续出现 `.enhanced-terminal-mcp`。
- 不为追求全局字符串一致而改写历史。
- 如果旧 decision 仍被当作当前规范引用，则更新或 supersede，不能让其继续声称旧行为仍有效。

### 旧 roadmap 收口

本次文档同步已执行：

- 删除旧 D `merge-plan.md` 的唯一替代已由本 roadmap 完成，不恢复重复文件。
- D 仓库副本的 `remaining-hardening` 中：
  - `contract-truncate-success`
  - `publish-es-optional`

  已改为 `dropped`，notes 明确写：

  ```text
  moved/superseded by merge-e-hardening-into-d/<new-item>
  ```

- 两项都转移后，D 副本 `remaining-hardening` 的所有 item 均为 `done` 或 `dropped`，主文档状态已改为 `completed`；E 目录仍由用户自行处理。
- 不把旧条目标为 `done` 来冒充它们按原设计实现过。

## 9. 观察项

- D 当前 architecture 已回写 Node >=20、27/26 工具、inactive ProcessPool、`.etmcp`、M2/M3 运行事实和 M4 build/package 收口。
- D 副本的旧 paging decision 已标记 `superseded`；当前 active decision 为 `2026-08-22-decision-command-output-spill-paging.md`。
- D 副本的 state/temp decisions 已更新为 `.etmcp` 与懒创建；历史 feature design/acceptance 仍保留原名称作为历史事实。
- 全局 `%TEMP%` session 可能属于其他项目，因此只提示、不自动迁移；若用户确实需要旧 D session，应单独人工核对。
- `es_tool/es.exe` 可留在源码仓库作开发夹具，但必须通过 package dry-run 证明未发布。
- 本 roadmap 不把应用层 hardening 描述为 OS sandbox 或形式化安全证明。

## 10. 变更日志

- 2026-08-19：初版。固定 D/E/共同祖先三个 commit；定义完整历史 merge、A+ 输出、`.etmcp`、可选 Everything、文档同步、回滚与完整验收契约。
- 2026-08-19：M1 `merge-e-hardening-base` 验收通过（merge commit `3f6d477`，双亲 `dee6771`+`e28f2e9`）。执行期修正：backup 锚点定为 `dee6771`（merge 前真实 HEAD，非 `7eea862`/`990f988`）；E 未携带 4.5 迁移实现，由 M1 在 D 侧按 4.5 协议新实现；`result.ts` 错误结构按 SDK 1.29 单一 object 约束落地为 `withErrorSchema`（M2 4.6 再收敛完整 envelope）；D 内联 `src/shell.test.ts` 归位 `tests/unit/`。详见 feature acceptance 报告。
- 2026-08-20：M2 进度重新对齐。确认 S1 已完成；S2 仅完成内存 scanner/差分与边界测试，staging 前扫描和落盘 fault injection 仍缺；S3 代码已大部分存在但关键资源治理矩阵未验收；S4 仍是旧 PageCache；S5 仅完成共享捕获入口接入，公开 envelope、batch/watch/cache/audit 契约未闭环；S6 尚未执行。roadmap item 与 feature checklist 均保留 `in-progress`，不提前宣称完成。
- 2026-08-21：完成当前状态文档同步：修正 README/AGENTS/ARCHITECTURE 的 `.etmcp`、错误码、测试快照和 M2 过渡口径；更新 state/temp/paging active decisions；将旧 `remaining-hardening` 的两个重复 planned 条目标记 `dropped` 并指向 M2/M3。未修改历史 feature 文档、E 仓库或代码。
- 2026-08-21：M2 `command-output-spill-paging` 验收通过。S1–S6 全部闭环：共享 A+ 捕获/溢写/分页/secret/容量/envelope 落地，cmd/powershell/pwsh 中文乱码闭环；乱码根因确认为 cmd 管道原始字节 GBK、pwsh/powershell UTF-8，修复落在 `command-output.ts` 原始字节编码判定（`shell.ts` 不变）。阶段 C 门禁全绿（build/tsc/lint/test 532 用例/test:latency 24 项/diff --check）。详见 feature acceptance 报告。
- 2026-08-21：M3 `publish-es-optional` design 获批，items.yaml 切换为 `in-progress`；先完成 S1–S2 resolver、显式/state 来源区分、fingerprint 失效和固定 hash 校验。
- 2026-08-22：M3 `publish-es-optional` 验收通过；S3–S5、12 项 checks、build/tsc/lint/543 tests/latency/package dry-run/零下载核对/diff --check 全部通过，items.yaml 改为 `done`。另修正既有 temp-manager TTL 测试时间余量，未改变生产行为；M4 保留为最终整体文档与发布收口。
- 2026-08-22：M4 最终本地收口完成；`build/` 增加 clean-before-build，项目内 `.etmcp/test-tmp` 验证通过，MCP smoke（27 tools、temp_stats、命令正常/错误、无/有 Everything 搜索路径）通过，npm pack 不含测试产物、`middleware` 或 `es.exe`；M4 item 改为 `done`。
- 2026-08-22：M4 收尾维护完成；将 `tests/unit/utils.extended.test.ts` 的 `vi.unmock()` 移到模块顶层，针对性测试与全量测试无 warning 通过。
- 2026-08-28：所有 items 已处于终态（`done` / `dropped`），将 roadmap 状态收口为 `completed`；后续维护以独立 feature / issue 为入口。
