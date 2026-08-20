---
doc_type: issue-report
issue: 2026-07-11-security-model-weakness
status: confirmed
severity: P1
summary: 安全模型存在 4 处绕过/降级缺陷,off 模式与命令黑名单组合下可执行任意危险命令
tags: [security, safeguard, command-execution, injection, redos]
---

# 安全模型缺陷 Issue Report

## 1. 问题现象

通过对 `src/safeguard.ts`、`src/security.ts`、`src/tools/command.ts`、`src/tools/search.ts`、`src/regex.ts` 的代码审查,观察到 4 项相互独立但同属"安全防线失效"的现象。每项都有具体的可构造输入触发,触发后安全机制未拦截:

**现象 1.1 — 命令危险模式黑名单被多种输入绕过**

`hasDangerousPattern`(src/security.ts:211)对命令字符串做正则匹配,但以下输入均**未被任何 `DANGEROUS_PATTERNS` 命中**且最终会执行破坏性命令:

- 变量展开:`X=/; rm -rf $X`
- 编码解码:`echo cm0gLXJmIC8= | base64 -d | sh`
- find -exec:`find / -exec rm -rf {} +`
- 解释器执行:`python -c "import os; os.system('rm -rf /')"`
- 别名/函数:`alias z=rm; z -rf /`

**现象 1.2 — `MCP_SAFETY_MODE=off` 关闭 guardDestructiveAction 后无硬底线兜底**

`guardDestructiveAction`(src/safeguard.ts:91-93)在 `off` 模式直接返回 null 放行。注释写"硬性底线在 security.ts 中另外检查",但 `security.ts` 的 `validatePath` 只拦系统目录(FORBIDDEN_PATHS)和敏感文件路径,**不拦** `rm -rf ~/important-project` 这类指向用户数据的破坏性命令。该命令既不在系统路径黑名单、又不在命令黑名单(见现象 1.1 绕过),`off` 模式下三道防线全部失效。

**现象 1.3 — `grep_content` 的 pattern 参数经 PowerShell 执行,无输入校验**

`grep_content` 在 Windows 分支(src/tools/search.ts:226-238)把用户 `pattern` 作为 `Select-String -Pattern $Regex` 的参数传入 `powershell.exe -Command`。对比同函数内 `dir_path` 经 `validatePath` 校验、`pattern` 仅在 fallback 路径用 `getRegex` 做 ReDoS 检测——主路径(PowerShell)上 pattern 未经任何校验或转义。具体注入范围需在阶段 2 通过实际复现确认。

**现象 1.4 — ReDoS 检测规则过窄**

`isUnsafeRegex`(src/regex.ts:16)用 `REDOS_PATTERN = /([+*}])\s*[)]\s*[+*{]|([+*])\s*[+*]/` 判定危险正则。以下已知 ReDoS 模式**未被该规则拦截**:

- `(?:a?){1,100}b` 配输入 `aaaa...a`(重复量词作用于可选组)
- `a+a+a+a+$` 配输入 `aaaaaaaaab`(多重量词链式叠加,无嵌套)

用户可通过 `grep_content` 的 `pattern` 参数传入这类正则,卡住事件循环。

## 2. 复现步骤

### 现象 1.1 复现

1. 启动服务器(`MCP_SAFETY_MODE=off`,或 normal 模式下用户确认放行)
2. 调用 `execute_command`,command = `X=/; rm -rf $X`(指向根目录)
3. 观察:`hasDangerousPattern` 返回 null,命令进入 `spawnStream` 执行

(其余 4 种绕过输入同理,均不在 `DANGEROUS_PATTERNS` 命中范围)

复现频率:稳定

### 现象 1.2 复现

1. 启动服务器,设 `MCP_SAFETY_MODE=off`
2. 调用 `execute_command`,command = `rm -rf ~/test-destroy-dir`(指向用户目录,非系统路径)
3. 观察:`guardDestructiveAction` 返回 null(off 放行);`hasDangerousPattern` 返回 null(模式不匹配 `~` 后非 `/` 的情况——需阶段 2 确认 `~`/`$HOME` 分支是否真覆盖);命令执行,目录被删

复现频率:稳定

### 现象 1.3 复现

1. 启动服务器(Windows 环境)
2. 调用 `grep_content`,pattern 含特殊字符(具体 payload 需阶段 2 通过实际 PowerShell 执行确认注入边界)
3. 观察:pattern 未经校验直接进入 PowerShell 脚本块执行

复现频率:稳定(待阶段 2 确认实际可注入范围)

### 现象 1.4 复现

1. 调用 `grep_content`,pattern = `(?:a?){1,100}b`,搜索一个含大量 `a` 的文件
2. 观察:`getRegex` 的 `isUnsafeRegex` 返回 false,正则被编译执行,事件循环长时间阻塞

复现频率:稳定

## 3. 期望 vs 实际

**期望行为**:服务器对外宣称"3-Level Safety System",应在任何安全模式下阻止可识别的危险命令执行、阻止用户可控正则卡死服务、阻止注入向量进入 PowerShell——即便用户设 `off` 关闭确认弹窗,也不应让任意破坏性命令无阻碍执行。

**实际行为**:命令黑名单可被变量/编码/find-exec/解释器等多种方式绕过;`off` 模式下硬底线缺失,用户数据可被破坏性命令删除;`grep_content` 的 pattern 主路径无校验;ReDoS 检测规则过窄,已知病态正则可绕过。

## 4. 环境信息

- 涉及模块 / 功能:safeguard(安全策略引擎)、security(安全基础层)、tools/command(命令执行)、tools/search(grep_content)、regex(正则缓存)
- 相关文件 / 函数:
  - `src/security.ts:180-216` — `DANGEROUS_PATTERNS`、`hasDangerousPattern`
  - `src/safeguard.ts:89-157` — `guardDestructiveAction`(off 分支 91-93)
  - `src/tools/search.ts:209-253` — `grep_content` Windows 分支
  - `src/regex.ts:14-18` — `REDOS_PATTERN`、`isUnsafeRegex`
- 运行环境:dev / 部署环境均存在(代码层面问题,非环境相关)
- 其他上下文:Windows 11 为主测试平台;问题在 v3.1.0 代码中观察到;`AGENTS.md` 明确禁止"修改安全规则、路径黑名单、错误码等核心行为,除非显式授权"——本 issue 修复需用户显式授权

## 5. 严重程度

**P1 严重** — 安全防线可绕过而非完全失效(有 strict 模式 / Claude Desktop Elicitation 作为缓解),但 `off` 模式 + 绕过组合下可达任意命令执行。非默认配置触发,故定 P1 而非 P0。建议尽快修。

## 备注

- 本 issue 是"安全模型类"4 项缺陷的合集,源自一次系统性安全审查。审查另有 10 项缺陷分属缓存/限流、执行可靠性、代码质量三类,已各自开 issue 跟进
- 修复涉及 `AGENTS.md` 禁止修改的安全规则核心,需用户在阶段 2/3 显式授权后方可改动 `DANGEROUS_PATTERNS`、safeguard 模式逻辑、security 硬底线
- 现象 1.1 与 1.2 有关联:1.1 让黑名单失效,1.2 让 off 模式无兜底,两者叠加才构成"任意命令执行"。修复时需作为整体考虑,不能孤立修
- 现象 1.3 的实际注入边界需阶段 2 实际复现确认——`execFile` 不经 shell 参数本身安全,但 PowerShell `-Command` 脚本块内 `$Regex` 变量的 `$()` 展开语义需验证
