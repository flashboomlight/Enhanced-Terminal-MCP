---
doc_type: issue-analysis
issue: 2026-07-11-security-model-weakness
status: confirmed
root_cause_type: missing-guard
related: [security-model-weakness-report.md]
tags: [security, safeguard, command-execution, injection, redos]
---

# 安全模型缺陷 根因分析

## 1. 问题定位

| 关键位置 | 说明 |
|---|---|
| `src/security.ts:180-216` | `DANGEROUS_PATTERNS` 数组 + `hasDangerousPattern()` 遍历正则匹配。这是 off/normal 模式下唯一的命令层防御,且只匹配命令字面量,不感知 shell 语义 |
| `src/safeguard.ts:91-93` | `guardDestructiveAction` 的 off 分支:`if (_mode === "off") return null`。放行后无任何兜底检查 |
| `src/safeguard.ts:96-106` | strict 分支禁用全部 GUARDED_TOOLS。这是当前唯一真正安全的模式 |
| `src/security.ts:117-126` | `isForbiddenPath` 只匹配 FORBIDDEN_PATHS(系统目录)。用户数据路径(`~/project`)不在内 |
| `src/tools/search.ts:226-238` | `grep_content` Windows 分支,pattern 作为 PowerShell `param([string]$Regex)` 传入。execFile 参数化本身安全,但 Select-String 接收的是正则字符串,且 pattern 未做 ReDoS/语法预检 |
| `src/regex.ts:14` | `REDOS_PATTERN` 单行正则,只覆盖最显式的嵌套量词 `(X+)+` 形态 |

## 2. 失败路径还原

### 现象 1.1(黑名单绕过)

**正常路径**:用户执行 `ls -la` → `hasDangerousPattern` 遍历 28 条正则 → 无命中 → 命令执行 → 返回结果

**失败路径**:用户执行 `python -c "import os; os.system('rm -rf /')"` → `hasDangerousPattern` 遍历 28 条正则 → **无命中**(没有任何模式覆盖 `python -c` + `os.system`)→ 命令进入 `spawnStream` → 解释器执行,`rm -rf /` 在子进程里跑

**分叉点**:`src/security.ts:211-215` — `hasDangerousPattern` 的返回值依赖正则覆盖面,而 shell 命令的语义空间远大于正则能枚举的范围。本质是**用字符串匹配对抗 shell 语义**,不可判定

### 现象 1.2(off 模式无兜底)

**正常路径**(strict):执行破坏性命令 → `guardDestructiveAction` strict 分支 → GUARDED_TOOLS 命中 → 直接拒绝

**失败路径**(off):执行 `rm -rf ~/project` → `guardDestructiveAction` off 分支返回 null → `hasDangerousPattern` 不命中(`~` 后跟非 `/` 路径不在模式内)→ `spawnStream` 执行 → 用户数据被删

**分叉点**:`src/safeguard.ts:92` — off 分支 `return null` 之前没有调用任何硬底线检查。注释"硬性底线在 security.ts 中另外检查"与实际不符:security.ts 的 `validatePath` 只在文件类工具(`read_file`/`write_file` 等)调用,**命令类工具根本不经过 `validatePath`**,只经过 `hasDangerousPattern`

### 现象 1.3(grep pattern 无校验)

**正常路径**:用户搜 `TODO` → `grep_content` → `validatePath(dir_path)` 通过 → PowerShell `Select-String -Pattern 'TODO'` → 返回匹配

**失败路径**:用户搜 `(?:a?){1,100}b` 或含 PowerShell 元字符的 pattern → `validatePath` 只校验 dir_path → pattern 直入 PowerShell → ReDoS 或非预期脚本行为

**分叉点**:`src/tools/search.ts:234` — pattern 未经 `getRegex`/`isUnsafeRegex` 预检就传入。而 fallback 路径(:293)反而做了 ReDoS 检测——主路径比 fallback 更宽松

### 现象 1.4(ReDoS 规则窄)

**正常路径**:pattern=`(a+)+` → `isUnsafeRegex` 命中 `([+*])\s*[+*]` → 抛错拒绝

**失败路径**:pattern=`(?:a?){1,100}b` → `isUnsafeRegex` 不命中(量词作用于 `?` 可选组,不匹配 `([+*}])\s*[)]\s*[+*{]`,也不匹配 `([+*])\s*[+*]`)→ 正则编译执行 → 输入 `aaaa...a` 触发指数回溯 → 事件循环阻塞

**分叉点**:`src/regex.ts:14` — `REDOS_PATTERN` 是单条手写正则,覆盖的语法形态有限。ReDoS 检测本身是个难问题(等价于停机问题),但当前规则连常见模式都漏

## 3. 根因

**根因类型**:missing-guard(缺少防御)+ 设计层假设错误

**根因描述**:

四个现象共享一个上层根因——**安全模型把"字符串模式匹配"当作命令/正则安全的主要防线,而这在语义上是不可判定的**。具体分:

- **1.1 的根因**:`hasDangerousPattern` 用正则枚举危险命令,但 shell 命令空间无限(变量、编码、管道、解释器、find -exec 等都能间接执行任意命令)。任何正则黑名单必然有漏,而它又是 off/normal 下唯一防线
- **1.2 的根因**:`guardDestructiveAction` 的 off 分支无兜底,且注释声称的"security.ts 硬底线"实际不覆盖命令类工具。off 模式语义是"关闭确认弹窗",实现成了"关闭一切检查"
- **1.3 的根因**:`grep_content` 主路径(PowerShell)对 pattern 零校验,比 fallback 路径更宽松。校验逻辑分散,fallback 有主路径没有
- **1.4 的根因**:`REDOS_PATTERN` 是单条手写正则,覆盖面窄。ReDoS 检测难做完美,但当前实现连教科书级病态模式都漏

**是否有多个根因**:是。四个现象各自有独立根因,但同属"字符串匹配防线不足"这一上层根因。1.1 和 1.2 强耦合(1.1 让黑名单失效,1.2 让 off 无兜底,叠加才达任意命令执行),修复时必须一起考虑

## 4. 影响面

- **影响范围**:1.1 影响所有命令工具(execute_command/batch_execute/watch_command);1.2 影响 off 模式下全部 GUARDED_TOOLS;1.3 影响 Windows 下 grep_content;1.4 影响 grep_content + search_files(pattern 参数)
- **潜在受害模块**:
  - `batch_execute`([command.ts:310](../../../src/tools/command.ts#L310))和 `watch_command` 复用同一个 `hasDangerousPattern`,1.1 修复需同步覆盖
  - `download_file`/`compress_archive`/`extract_archive` 的路径校验走 `validatePath`,不受 1.2 影响(已说明),但 off 模式下它们的 `guardDestructiveAction` 也被放行——需确认是否也要加硬底线
  - 1.4 的 ReDoS 修复若改为更严格的检测,可能误拦合法正则(如 `(a+)+` 在小输入下无害),需权衡误报
- **数据完整性风险**:有。1.1+1.2 组合下用户数据可被破坏性命令删除,不可逆
- **严重程度复核**:维持 P1。理由:四个现象叠加可达任意命令执行,但触发条件是 `off` 模式 + 构造性输入,非常规使用路径。strict 模式和 Claude Desktop Elicitation 仍有效作为缓解

## 5. 修复方案

### 现象 1.1 + 1.2(命令防线 + off 兜底,合并修)

#### 方案 A:加硬底线函数 + 扩充黑名单(渐进加固)

- **做什么**:
  1. 在 `security.ts` 新增 `hardBlock(command)` 函数,内含一份**不可关闭**的最低限度黑名单(只覆盖 `rm -rf /|~|*`、`mkfs`、`dd of=/dev/`、`> /dev/sd`、fork bomb 等极少数真正灾难性模式)
  2. `guardDestructiveAction` 的 off 分支调用 `hardBlock`,命中则拒绝(即便 off 也拦)
  3. `hasDangerousPattern` 保留但标注"best-effort,非唯一防线"
  4. 补充几条明显遗漏:find -exec rm、`sh -c`/`bash -c` 后跟 rm、`python -c.*os.system`、`base64 -d | sh` 的显式管道
- **优点**:改动局部,不破坏现有契约;off 模式有了真正硬底线;strict/normal 行为不变
- **缺点 / 风险**:hardBlock 仍是正则,理论上仍可绕过(但只拦"灾难性"模式,绕过收益低);补充的黑名单仍非完备
- **影响面**:`security.ts`(新增函数+补模式)、`safeguard.ts`(off 分支加调用)、`command.ts`(可选,在 hasDangerousPattern 后追加 hardBlock 检查)。不影响工具输入输出契约

#### 方案 B:off 模式直接禁用命令类工具(对齐 strict 语义)

- **做什么**:`guardDestructiveAction` 的 off 分支对 GUARDED_TOOLS 中的命令工具(execute_command/batch_execute/watch_command)也拒绝,引导用户用 normal 模式
- **优点**:最安全,off 模式不再有命令执行能力
- **缺点 / 风险**:**破坏 off 模式语义**——用户设 off 就是想免确认执行命令,这个改法等于废除 off 模式对命令工具的意义。可能不符合用户预期
- **影响面**:`safeguard.ts` 单文件。但改变了 off 模式承诺的行为,需更新 README

#### 方案 C:命令执行前强制解析+白名单(重设计)

- **做什么**:废弃 `hasDangerousPattern`,改用 AST/参数化执行——解析命令首词到白名单,参数走 execFile 参数化传入,禁止 shell 串拼接
- **优点**:从根本上解决绕过问题
- **缺点 / 风险**:**改动巨大**,破坏现有"执行任意 shell 命令"的工具能力。execute_command 的核心价值就是能跑 shell,白名单会让它失去意义。工作量超出本 issue 范围
- **影响面**:重写 `command.ts`、`platform.ts`、`security.ts` 命令相关部分。属于架构级改动

**推荐方案 A**(1.1+1.2)。理由:在保持工具能力前提下补上 off 模式硬底线,改动范围可控,不破坏现有契约。方案 B 改变 off 语义风险高,方案 C 超出 issue 范围。方案 A 不追求完美(仍可被高阶绕过),但堵住了"灾难性命令在 off 模式无阻碍"这个 P1 痛点

### 现象 1.3(grep pattern 无校验)

#### 方案 A:主路径补 ReDoS 预检 + 正则语法校验

- **做什么**:在 `grep_content` Windows 分支调用 PowerShell 前,对 pattern 调 `getRegex(pattern, "gi")` 做编译校验——既检测 ReDoS 又检测语法错误,失败则 fail 返回
- **优点**:与 fallback 路径校验逻辑统一;零 PowerShell 改动
- **缺点 / 风险**:PowerShell 和 JS 正则语法略有差异,JS 通过的可能 PowerShell 报错(罕见,可接受)
- **影响面**:`search.ts` 单文件,加 2-3 行

#### 方案 B:pattern 白名单字符过滤

- **做什么**:只允许 pattern 含 `[a-zA-Z0-9._\-*?\\^$|()\[\]{}]`,拒绝其他字符
- **优点**:彻底杜绝 PowerShell 元字符注入面
- **缺点 / 风险**:误拦合法正则(如 `\d` 的反斜杠、`{1,100}` 量词需允许),实际白名单设计复杂;且 Select-String 本就接正则,白名单过严会削弱工具能力
- **影响面**:`search.ts`

**推荐方案 A**(1.3)。理由:与现有 fallback 校验对齐,改动最小,不削弱正则能力

### 现象 1.4(ReDoS 规则窄)

#### 方案 A:扩展 ReDoS 检测为多条规则

- **做什么**:`isUnsafeRegex` 从单条正则改为多条检测:嵌套量词、量词作用于可选/分组(`(?:X?){n,}`、`(X*){n,}`)、重叠交替量词(`a+a+`)、量化捕获组重复等。并加长度上限(如 pattern > 200 字符拒绝)
- **优点**:覆盖面显著提升;仍保持纯检测、低开销
- **缺点 / 风险**:仍非完备(ReDoS 不可判定);多条规则可能误报合法正则
- **影响面**:`regex.ts` 单文件

#### 方案 B:加执行超时兜底

- **做什么**:保留现有 `isUnsafeRegex`,在 `grep_content` 的 fallback grepFile 执行处加 `setTimeout` 兜底,超时则中止
- **优点**:不依赖检测准确性,对任何 ReDoS 都有兜底
- **缺点 / 风险**:JS 同步正则执行无法被 setTimeout 中断(会阻塞事件循环),这个方案在 Node 同步正则下**不生效**。需改用 `re2` 库或 worker 执行,引入新依赖(违反 AGENTS.md "禁止引入新运行时依赖")
- **影响面**:若用 re2 需加依赖,违规

#### 方案 C:扩展检测 + pattern 长度上限 + 输入长度上限

- **做什么**:方案 A 基础上,额外限制 pattern 长度(如 ≤ 200 字符)和单行扫描长度(已有 max_results,补 max_line_length 截断)
- **优点**:纵深防御,长度限制能拦住大部分病态构造
- **缺点 / 风险**:对超长合法正则误拦(罕见)
- **影响面**:`regex.ts` + `search.ts`

**推荐方案 A**(1.4)。理由:方案 B 在同步正则下无效且引入依赖违规;方案 C 是方案 A 的超集但额外改动。方案 A 纯扩展检测规则,改动集中、无新依赖、不破坏契约。若后续发现误报,再叠加方案 C 的长度限制

## 推荐方案汇总

| 现象 | 推荐方案 | 改动文件 |
|---|---|---|
| 1.1 + 1.2 | 方案 A:hardBlock 硬底线 + 补充黑名单 | `security.ts`、`safeguard.ts`、(可选)`command.ts` |
| 1.3 | 方案 A:主路径补 getRegex 预检 | `search.ts` |
| 1.4 | 方案 A:扩展 ReDoS 检测为多条规则 | `regex.ts` |

三处推荐方案共同特点:改动集中在安全核心文件、不引入新依赖、不破坏现有工具输入输出契约、不改变 off/strict/normal 的对外语义(strict/normal 行为不变,off 模式增加硬底线)。
