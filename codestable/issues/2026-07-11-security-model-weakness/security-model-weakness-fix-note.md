---
doc_type: issue-fix
issue: 2026-07-11-security-model-weakness
path: standard
fix_date: 2026-07-11
related: [security-model-weakness-analysis.md]
tags: [security, safeguard, command-execution, injection, redos]
---

# 安全模型缺陷 修复记录

## 1. 实际采用方案

三处全部采用 analysis 推荐的方案 A:

- **1.1 + 1.2(命令防线 + off 兜底)**:在 `security.ts` 新增 `hardBlock()` 硬底线函数,只覆盖灾难性命令模式(`rm -rf /`/`mkfs`/`dd of=/dev/`/fork bomb/format/关机/chmod 777 全盘),在三个命令工具(execute_command/batch_execute/watch_command)中**所有安全模式下**(含 off)调用。同时补充 `DANGEROUS_PATTERNS` 黑名单覆盖 find -exec rm、sh -c/bash -c rm、python -c os.system、base64 -d|sh
- **1.3(grep pattern 无校验)**:`grep_content` Windows 主路径调用 PowerShell 前用 `getRegex` 预检 pattern,与 fallback 路径校验统一
- **1.4(ReDoS 规则窄)**:`isUnsafeRegex` 从单条正则扩展为 4 条互补规则,新增 pattern 长度上限 200

### 与 analysis 的一处实现调整

analysis 原写"safeguard.ts off 分支调用 hardBlock"。实现时改为**在 command.ts 三个命令工具中、所有模式下都调用 hardBlock**(不只 off 分支)。理由:

1. `guardDestructiveAction` 签名只接收 `(toolName, description)`,无 command 参数,要调 hardBlock 必须改签名影响所有调用点
2. 让 hardBlock 对 strict/normal/off **全模式生效**比只 off 生效更安全——strict 模式原本就禁用命令工具,hardBlock 是冗余加固不改变其行为;normal/off 模式下 hardBlock 成为不可关闭的底线
3. 改动更集中(都在命令工具内),不破坏 guardDestructiveAction 通用契约

此调整不改变 analysis 的修复目标(给 off 模式补硬底线),反而覆盖面更广。strict/normal 的对外行为不变(strict 仍全禁,normal 仍走 Elicitation)。

## 2. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/security.ts` | 补充 4 条 `DANGEROUS_PATTERNS`(find -exec rm / sh -c rm / python -c os.system / base64\|sh);新增 `hardBlock()` 函数 + `HARD_BLOCK_PATTERNS`(10 条灾难性模式) |
| `src/tools/command.ts` | import 加 `hardBlock`;execute_command/batch_execute/watch_command 三处在 `hasDangerousPattern` 之后追加 `hardBlock` 检查 |
| `src/tools/search.ts` | `grep_content` 在 `validatePath` 之后、PowerShell 调用之前加 `getRegex(pattern, "gi")` 预检 |
| `src/regex.ts` | `isUnsafeRegex` 从单条 `REDOS_PATTERN` 改为 `REDOS_PATTERNS` 数组(4 条规则);新增 `MAX_REGEX_PATTERN_LEN=200` 长度上限 |

未触碰 analysis 范围外任何文件。`safeguard.ts` 未改(理由见上节"实现调整")。

## 3. 验证结果

### build / lint

- `npx tsc --noEmit` 通过(EXIT 0)
- `npm run build` 通过
- `npm run lint` 通过(58 files, No fixes applied)

### 单元测试

- `src/security.test.ts` + `src/safeguard.unit.test.ts` + `src/safeguard.extended.test.ts` + `src/regex.ts` 相关:72 passed
- `src/tools/search.test.ts`:4 passed
- 本次改动相关测试合计 76 passed,0 failed

### 复现步骤验证(按 report 第 2 节)

自建 verify-fix.mjs 脚本调用编译产物,23 项检查全过:

**现象 1.1(黑名单绕过补充)**:
- ✓ `find / -exec rm -rf {} +` 被拦截
- ✓ `sh -c 'rm -rf /'` 被拦截
- ✓ `python -c "import os; os.system('rm -rf /')"` 被拦截
- ✓ `echo cm0gLXJmIC8= | base64 -d | sh` 被拦截
- ✓ 变量展开 `X=/; rm -rf $X` 仍 miss `hasDangerousPattern`(预期),但被 `hardBlock` 兜底拦截

**现象 1.2(hardBlock 硬底线)**:
- ✓ `rm -rf /` / `rm -rf ~` / `rm -rf $HOME` / `rm -rf $X`(变量形态)均被 hardBlock 拦截
- ✓ `mkfs.ext4 /dev/sda1` / `dd of=/dev/sda` / fork bomb / `format C:` 均拦截
- ✓ `ls -la` / `npm run build` 不误拦

**现象 1.3(grep pattern 预检)**:已通过代码检查确认主路径调用 `getRegex` 预检(语法+ReDoS),与 fallback 统一。病态 pattern `(?:a?){1,100}b` 在预检阶段即被拒

**现象 1.4(ReDoS 扩展检测)**:
- ✓ `(?:a?){1,100}b` 被拦(analysis 点名的病态模式,现已覆盖)
- ✓ `(a*)+` / `a+a+a+a+` / `(X+)+` 均被拦
- ✓ `TODO` / `\d+` / `[a-z]{1,3}` 不误拦
- ✓ 超 200 字符 pattern 被拦

### 全量测试的已知失败项(非本次回归)

`npm test` 全量跑时 `src/session.test.ts` 有 3 个用例失败(history 持久化条数、cwd 恢复、env 恢复)。已通过 git stash 对比验证:

- **baseline(无本次改动)单独跑 session.test.ts**:10/10 passed
- **带本次改动单独跑 session.test.ts**:10/10 passed
- **带本次改动全量跑(28 文件并发)**:3 failed

结论:这是 **session 异步加载竞态**(report 第 7 项缺点,属 `execution-reliability` issue)在全量并发压力下复现,**非本次改动引入的回归**。本次 issue 范围不修此项,留待 execution-reliability issue 处理。

## 4. 遗留事项

1. **session 异步加载竞态**(report 第 7 项):全量测试压力下复现,已归入 execution-reliability issue 处理
2. **hardBlock 仍非完备**:方案 A 本就不追求完美,高阶绕过(如 `perl -e 'system("rm -rf /")'`、自定义编码链)仍可绕过 hardBlock。这是 P1 修复的已知边界,不是 bug——彻底解决需方案 C(命令白名单重设计),超本 issue 范围
3. **1.3 grep 注入边界未做实弹复现**:本次只在主路径加了 `getRegex` 预检(防 ReDoS+语法错误),未实际构造 PowerShell `-Command` 脚本块的注入 payload 验证。若后续发现真实注入向量,可另开 issue
4. **AGENTS.md 安全核心授权**:本次改动触及 `DANGEROUS_PATTERNS`、新增 `hardBlock`/`HARD_BLOCK_PATTERNS`(均属 AGENTS.md 禁止改动的"安全规则/路径黑名单"核心),已获用户显式授权。授权范围限本 issue
