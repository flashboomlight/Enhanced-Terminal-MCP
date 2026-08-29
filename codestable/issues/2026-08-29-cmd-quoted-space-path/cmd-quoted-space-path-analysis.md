---
doc_type: issue-analysis
issue: 2026-08-29-cmd-quoted-space-path
status: confirmed
root_cause_type: data-format
related: [cmd-quoted-space-path-report.md]
tags: [cmd, quoting, windows, spawn, verbatim-args, shell-invocation]
created: "2026-08-29"
---

# cmd flavor 无法安全携带带引号的空格路径 根因分析

## 1. 问题定位

| 关键位置 | 说明 |
|---|---|
| `src/shell.ts:271`（`buildShellInvocation`，0-based；1-based 272-286） | cmd 分支返回 `args: ["/c", wrapCommand(command)]`——把**整条命令串**（含用户引号）作为单个 argv 元素交给 spawn，未设置 `windowsVerbatimArguments` |
| `src/shell.ts:343`（`wrapCommand`） | 预置 `chcp 65001 >nul && ` 前缀（该前缀本身无害） |
| `src/stream.ts:46-49`（`spawnStream` → `processSupervisor.spawnManaged`） | options 是窄化接口，**未携带** `windowsVerbatimArguments` |
| `src/process-supervisor.ts:30`（`ManagedSpawnOptions extends Omit<SpawnOptions,"signal">`）+ `spawnManaged` 的 `...spawnOptions` 透传 | supervisor 层**已经天然支持**该选项——透传缺口在中间窄化层，不在 supervisor |
| `src/process-supervisor.ts:68-72`（`ManagedExecFileOptions`） | 窄化接口只有 cwd/env/maxBuffer，`execFileManaged` 同样不带该选项（search.ts 路径） |

调用方全景（全部 shell 执行收敛于 `buildShellInvocation`，无旁路）：`stream.ts quickExec`、`utils.ts safeExec`、`tools/command.ts` 两处（execute/watch 经 `prepareInvocation`，batch 第 613 行）、`tools/search.ts:380`（grep_content 的 PS 脚本）→ 三个中间层：`spawnStream`、`runCommandOutput`（command-output.ts → capture.ts）、`execFileManaged`。

## 2. 失败路径还原

**正常路径**（无引号命令，Case C 证据）：`execute_command "echo hi"` → cmd 分支 → `spawn("cmd.exe", ["/c", "chcp 65001 >nul && echo hi"])` → 该 argv 元素含空格但**无引号**，Node 仅做整体包裹 `cmd.exe /c "chcp 65001 >nul && echo hi"` → cmd `/c` 旧式剥引号后命令串完整还原 → 成功。

**失败路径**（引号 + 空格，Case A/D 证据）：`type "D:\ALL MCP\...\probe file.txt"` → 同上构造 → Node 按 MS CRT 规则拼接命令行：整参数重包裹成一对引号、**内嵌引号转写为 `\"`**。Case D 让 cmd 回显自己收到的原始命令行，铁证如下：

```text
cmd.exe /c "chcp 65001 >nul & echo [%cmdcmdline%] & type \"D:\ALL MCP\...\probe dir with space\probe file.txt\""
```

→ cmd 的 `/c` 引号剥除规则（"恰好两个引号"特例不成立，落入旧式"剥最外层一对"）把外层引号剥掉后，残留的 `\"` 序列对 cmd 而言是**字面反斜杠+引号**（cmd 不做反斜杠转义），`type` 收到的路径 token 变成 `\"D:\...\probe file.txt\` ——引号位置错乱 → `文件名、目录名或卷标语法不正确`。

**分叉点**：`src/shell.ts:271`——cmd 分支依赖 Node 默认 argv 转义，而该转义规则与 cmd.exe 的解析规则在"引号 + 空格"场景下**根本不相容**（不是参数写错，是两侧规则冲突）。

## 3. 根因

**根因类型**：data-format（进程间输入格式假设不符——Node 的 Windows argv 序列化假设接收方按 CRT/`CommandLineToArgvW` 规则解参，`cmd.exe` 恰恰不按该规则解析）。

**根因描述**：Node `spawn` 在 Windows 上默认把 `args` 数组按 MS CRT 引号规则拼成命令行；这条规则只有走 CRT 解析的程序（pwsh/powershell——所以默认档没事）才能正确还原。`cmd.exe` 用自己的 tokenizer 解析 `/c` 之后的文本：内嵌引号被转写成 `\"` 后引号配对错位、路径 token 被污染。修复必须让 Node **原样拼接**（`windowsVerbatimArguments: true`）并由调用构造方自己保证最终命令行形态合法——业界标准形态是 `cmd /d /s /c "<整条命令>"`（npm、cross-spawn 同款），`/S` 让 cmd 只剥最外层一对引号、内部引号原样保留（Case F/H 实证）。

**是否有多个根因**：否。中间窄化层不透传 `windowsVerbatimArguments` 是同一根因的衍生传播缺口，不是独立根因。

## 4. 影响面

- **影响范围**：`MCP_SHELL=cmd` 兼容档下的全部 shell 执行（execute_command / batch_execute / watch_command / quickExec / safeExec / batch 子命令）。默认 pwsh 7 档、powershell 兼容档、unix 不受影响（pwsh 走 CRT 解析，`\"` 能正确还原）。
- **潜在受害模块**：`tools/search.ts` 的 grep_content 在 cmd flavor 下传入的是 PowerShell 脚本文本——cmd 下本就无法执行 PS 脚本（与本 issue 无关的既有边界，修复不改变其状态，记录为相邻观察）；supervisor 的 `taskkill`/`execFile` 直接调用均走数组参数且无 shell，不受影响。
- **数据完整性风险**：无（失败模式是命令执行失败，不产生错误写入）。
- **严重程度复核**：维持 **P2**（opt-in 兼容档 + 有文档化绕过），但用户已将其列为发布前必清项。

## 5. 修复方案

### 方案 A：cmd 分支 verbatim + 整体引号 + `/d /s /c`（推荐，npm/cross-spawn 业界标准）

- **做什么**：
  1. `shell.ts`：`ShellInvocation` 增加可选 `windowsVerbatimArguments?: boolean`；cmd 分支改为 `args: ["/d", "/s", "/c", `"${wrapCommand(command)}"`]` + `windowsVerbatimArguments: true`；
  2. 选项沿窄化层透传：`spawnStream`（stream.ts）、`safeExec`（utils.ts）、`runCommandOutput`（command-output.ts）、`captureCommand`（capture.ts）、`execFileManaged` + `ManagedExecFileOptions`（process-supervisor.ts）各加一字段并转发；调用方（command.ts ×2、search.ts、quickExec）从 `inv.windowsVerbatimArguments` 读值传入；
  3. 单测：`buildShellInvocation` cmd 分支新形态断言 + Windows 下经 `spawnStream` 真实 spawn 引号空格路径的回归（`resetShellSpecCache()` 切 cmd spec）。
- **优点**：根因直接（唯一能在 Node 内正确驱动 cmd 的方式）；`/S` 使引号语义确定化；`/D` 隔离注册表 AutoRun，执行环境可预测；对无引号命令零行为变化（Case G/H 实证）。
- **缺点 / 风险**：`/D` 对依赖 cmd AutoRun 的环境是可见行为变化（极罕见，且属正向隔离）；verbatim 后引号合法性完全由构造方负责——用户命令串自身引号不配对时的失败模式与交互式 cmd 一致（可接受）。
- **影响面**：8 个文件，除 `shell.ts` 一处逻辑外均为机械 option 透传；不触碰 pwsh/powershell/unix 分支与安全核心。

### 方案 B：同 A 但用 `/s /c`（不带 `/D`）

- **做什么**：与 A 相同，仅去掉 `/d`。
- **优点**：与现状的行为差最小（保留 AutoRun 语义）。
- **缺点 / 风险**：AutoRun 脚本会在每次命令前执行——执行环境不可预测，与 v4.0.0"可预测执行"方向相悖；无其他收益。

### 方案 C：不修执行链，cmd flavor 检测"引号 + 空格"时显式报错并提示绕过（cwd + basename 或切 pwsh）

- **做什么**：在 `command.ts` 入口加检测分支返回结构化错误。
- **优点**：零执行核心风险，改动 1 处。
- **缺点 / 风险**：功能继续缺失，与用户"发布后不想维护、要真正修好"的目标直接冲突；错误检测的启发式（引号 + 空格判定）易误报。

### 推荐方案

**推荐方案 A**，理由：它是唯一消除根因的选项（B 与 A 只差一个开关，C 不修根因），`/d /s /c` + 整体引号是 npm 与 cross-spawn 验证多年的标准形态，实证矩阵（Case F/G/H）已覆盖引号路径、命令链、普通命令回归三种场景；透传面虽涉及 8 个文件但全部为机械字段转发，且 supervisor 层已天然支持，实际风险集中在 `shell.ts` 单点逻辑。

---

**多轮审计记录**：Round 1（执行链全景）确认全部 shell 执行已收敛于 `buildShellInvocation`（safeExec 亦然），无旁路遗漏；Round 2（对照排除）确认 pwsh 档不受影响、taskkill/execFile 直调不受影响、grep_content×cmd 为与本 issue 无关的既有边界；Round 3（修复形态实证）Case F/G/H 全过 + Case D 铁证固定，无新问题 → 定稿（status: confirmed，checkpoint 按 `CS-AUTOMATION.md` 授权代行）。
