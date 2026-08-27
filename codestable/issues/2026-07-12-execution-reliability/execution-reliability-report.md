---
doc_type: issue-report
issue: 2026-07-12-execution-reliability
status: confirmed
severity: P2
summary: session 异步加载竞态、scanContent 误报、spawnStream 截断丢数据、优雅退出 500ms 过短
tags: [reliability, session, concurrency, output-truncation, shutdown]
---

# 执行可靠性缺陷 Issue Report

## 1. 问题现象

通过对 `src/session.ts`、`src/scan.ts`、`src/stream.ts`、`src/index.ts` 的代码审查 + 实际测试,观察到 4 项现象:

**现象 3.1 — session 异步加载竞态**

`SessionStore` 构造函数([src/session.ts:26-28](../../../src/session.ts#L26))调 `this.loadFromDisk()`,后者走 `loadNewFile().catch(() => loadLegacyFile())` 的异步链([session.ts:127-155](../../../src/session.ts#L127)),**整个加载在 `new SessionStore()` 返回后才完成**。`main()` 里 [index.ts:66](../../../src/index.ts#L66) `await tempManager.init()` 是异步等待的,但 session 是模块顶层 `export const session = new SessionStore()`([session.ts:170](../../../src/session.ts#L170))立即实例化——`server.connect` 后若立即有工具调用,`session.getCwd()` 可能返回 `process.cwd()` 而非磁盘恢复的 cwd。

实测:全量 `npm test`(28 文件并发)时 `src/session.test.ts` 有 3 个用例失败(history 持久化条数、cwd 恢复、env 恢复),但单独跑 `npx vitest run src/session.test.ts` 全过(10/10)。说明竞态在高并发压力下复现。

**现象 3.2 — scanContent 误报阻断合法写入**

`scanContent`([src/scan.ts:9-23](../../../src/scan.ts#L9))的 `Generic API Key` 正则 `api[_-]?key...{16,}` 和 `Connection String` 正则误报面大。实测构造:
- `api_key=1234567890123456`(16 字符纯数字,合法短 key)→ 被误拦
- 文档/示例文本含 `mongodb://user:pass@host` → 被误拦

`write_file`([src/tools/files.ts:142-150](../../../src/tools/files.ts#L142))对 `!scan.safe` 硬性 `return fail`,用户无法 override。AI 写测试文件、写文档示例时被误阻断。

**现象 3.3 — spawnStream 截断丢数据且判硬失败**

`spawnStream`([src/stream.ts:66-76](../../../src/stream.ts#L66))stdout 超 `maxOut` 后 `truncated=true` 并 kill,但 `stdoutChunks.push(chunk)` 只在未超限时入栈——超限后数据全丢。调用方 [command.ts:160-177](../../../src/tools/command.ts#L160) 对 `truncated` 返回硬错误。大输出命令(如 `npm run build` 日志)被整条判失败,LLM 拿不到任何输出诊断。stderr 1MB 上限([stream.ts:49](../../../src/stream.ts#L49))静默丢弃无标志。

**现象 3.4 — 优雅退出 500ms 过短**

`index.ts:82` `setTimeout(() => process.exit(0), 500).unref()`。`session.flush` 有 5s 去抖、`audit.flush` 有 1s 去抖([session.ts:95](../../../src/session.ts#L95)、[audit.ts:67](../../../src/audit.ts#L67)),500ms 内写盘可能来不及,尤其 Windows 下大文件 append。

## 2. 复现步骤

### 现象 3.1 复现

1. 在磁盘 session.json 写入 `cwd: "E:\\restored-path"`
2. 启动服务器,立即(加载未完成时)调 `execute_command` 读 `session.getCwd()`
3. 观察:可能返回 `process.cwd()`(D:\MCP Development\...)而非磁盘恢复的 cwd

复现频率:概率(全量测试并发压力下稳定复现 3/10 用例;单独跑不复现)

### 现象 3.2 复现

1. 调 `write_file`,content=`api_key=1234567890123456`
2. 观察:`scanContent` 命中 `Generic API Key`,`write_file` 返回 `PATH_SENSITIVE` 错误,写入被拦

复现频率:稳定

### 现象 3.3 复现

1. 调 `execute_command`,command=`npm run build`(产出大量日志)
2. 观察:输出超 `MCP_COMMAND_MAX_OUTPUT_BYTES`(默认 50MB,但大项目可能触发),`truncated=true`,返回 `EXECUTION_FAILED` 硬错误,LLM 拿不到任何 stdout

复现频率:稳定(大输出场景)

### 现象 3.4 复现

1. 触发 SIGINT/SIGTERM
2. 观察:500ms 后 process.exit,session/audit 的去抖写盘可能未完成

复现频率:概率(取决于待写数据量与磁盘速度)

## 3. 期望 vs 实际

**期望行为**:session 在服务器接受请求前完成加载;scanContent 不误拦合法短 key / 文档示例;大输出命令截断时返回部分输出而非硬失败;优雅退出给足时间写盘。

**实际行为**:session 加载是 fire-and-forget;scanContent 误报面大且不可 override;截断返回硬错误丢全部输出;退出窗口 500ms。

## 4. 环境信息

- 涉及模块 / 功能:session(状态管理)、scan(密钥扫描)、stream(命令执行)、index(生命周期)
- 相关文件 / 函数:
  - `src/session.ts:26-28,127-155,170` — 构造函数异步加载、顶层实例化
  - `src/scan.ts:9-23` — SECRET_PATTERNS
  - `src/tools/files.ts:142-150` — write_file scanContent 硬阻断
  - `src/stream.ts:49,66-76` — maxStderr、stdout 截断逻辑
  - `src/tools/command.ts:160-177` — truncated 硬错误
  - `src/index.ts:82` — 退出 500ms
- 运行环境:dev / 部署均存在
- 其他上下文:现象 3.1 已在 security-model issue 全量测试中观察到(baseline 单跑过、全量失败),确认非该 issue 回归

## 5. 严重程度

**P2 中等** — 3.1 是竞态(概率触发,影响首次命令目录);3.2 是误报阻断(影响 AI 写文件);3.3 是大输出硬失败(影响诊断);3.4 是退出丢日志(概率)。无数据破坏,但影响可靠性。计划内修。

## 备注

- 现象 3.1 的修复需谨慎:session 是模块顶层实例化,改成 await 涉及初始化时序重构,需评估对 index.ts 启动流程的影响
- 现象 3.2 需权衡:降低正则敏感度可能漏拦真密钥;加 override 机制可能被滥用
- 现象 3.3 改"截断返回部分输出"会改变现有工具输出契约(execute_command 的 outputSchema),需确认是否破坏 AGENTS.md "禁止破坏工具契约"红线——若改契约需显式授权
- 现象 3.4 简单,加大退出窗口即可
