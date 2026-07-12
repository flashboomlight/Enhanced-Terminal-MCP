---
doc_type: issue-analysis
issue: 2026-07-12-execution-reliability
status: confirmed
root_cause_type: concurrency
related: [execution-reliability-report.md]
tags: [reliability, session, concurrency, output-truncation, shutdown]
---

# 执行可靠性缺陷 根因分析

## 1. 问题定位

| 关键位置 | 说明 |
|---|---|
| `src/session.ts:170` | `export const session = new SessionStore()` 模块顶层立即实例化 |
| `src/session.ts:26-28` | 构造函数调 `loadFromDisk()` 但不 await,fire-and-forget |
| `src/session.ts:127-155` | `loadFromDisk` → `loadNewFile().catch(() => loadLegacyFile())`,异步链在构造返回后完成 |
| `src/index.ts:66-69` | `await tempManager.init()` 等了 temp,但 session 在模块 import 时已实例化,index 无法 await session 加载 |
| `src/scan.ts:20` | `Generic API Key` 正则 `api[_-]?key...{16,}`,16 字符阈值过低 |
| `src/scan.ts:21` | `Connection String` 正则匹配 `mongodb://...:...@`,文档示例文本也命中 |
| `src/tools/files.ts:142-150` | write_file 对 `!scan.safe` 硬性 `return fail`,无 override |
| `src/stream.ts:66-76` | stdout 超 maxOut 后 `truncated=true` 并 kill,超限后 chunk 不入栈,数据丢 |
| `src/stream.ts:49` | maxStderr=1MB 静默丢弃 |
| `src/tools/command.ts:160-177` | truncated 返回 EXECUTION_FAILED 硬错误 |
| `src/index.ts:82` | `setTimeout(..., 500)` 退出窗口 |

## 2. 失败路径还原

### 现象 3.1(session 竞态)

**正常路径**(加载完成):import session → 构造函数触发 loadFromDisk → 异步链完成 → state.cwd = 磁盘值 → 工具调 getCwd() 返回恢复值

**失败路径**(加载未完成):import session → 构造函数触发 loadFromDisk(异步,未完成)→ server.connect → 工具调 getCwd() → 返回 freshState 的 `process.cwd()` → 后续异步链才完成覆盖 state,但首次命令已跑错目录

**分叉点**:`src/session.ts:127` — `loadFromDisk` 是 async 但构造函数不 await。`applyState` 在 promise 链尾端执行,晚于 `new SessionStore()` 返回。并发压力下其他测试的 import 完成后才轮到 session 的异步链,放大了窗口

### 现象 3.2(scanContent 误报)

**正常路径**:write_file 写真密钥 → scanContent 命中 → 阻断,保护凭据

**失败路径**:write_file 写 `api_key=1234567890123456`(合法短 key)→ scanContent 的 `Generic API Key` 正则 `{16,}` 命中 → 返回 PATH_SENSITIVE 错误 → AI 写文件被拦

**分叉点**:`src/scan.ts:20` — `{16,}` 阈值过低 + 无 allowlist。16 字符纯数字不是任何主流 API key 格式,但正则无法区分

### 现象 3.3(截断丢数据)

**正常路径**:命令输出 < maxOut → stdout 全收集 → 返回

**失败路径**:命令输出 > maxOut → `stdoutLen > maxOut` → truncated=true + kill,但超限后的 chunk `else` 分支不入 stdoutChunks → 最终 stdout = 超限前已收集部分 + "...(TRUNCATED)" → 调用方判 truncated 返回 EXECUTION_FAILED 硬错误 → LLM 拿不到任何 stdout

**分叉点**:`src/stream.ts:68-76` — 超限后停止收集。调用方 `src/tools/command.ts:160` 把 truncated 当硬错误

### 现象 3.4(退出窗口)

**正常路径**:SIGINT → shutdown → session.flush(去抖 5s) + audit.flush(去抖 1s) → 500ms 后 exit

**失败路径**:去抖 timer 未触发写盘前 500ms 到 → process.exit → 待写数据丢

**分叉点**:`src/index.ts:82` — 500ms 窗口小于 session 的 5s 去抖 + audit 的 1s 去抖

## 3. 根因

**根因类型**:concurrency(3.1)+ data-format(3.2 正则阈值)+ logic(3.3 截断策略)+ config(3.4 常量)

**根因描述**:

- **3.1**:session 是模块顶层实例化 + 构造函数 fire-and-forget 异步加载,没有"加载完成"的同步点。index.ts 无法 await 一个在 import 时已跑的异步链
- **3.2**:scanContent 的正则敏感度与阻断策略问题——阈值低 + 无 override,把"疑似"当"确凿"硬拦
- **3.3**:stream.ts 的截断策略是"丢弃 + 硬错误",而非"保留部分 + 降级返回"。调用方把可恢复的截断当不可恢复错误
- **3.4**:退出常量 500ms 与 session/audit 的去抖周期不匹配

**是否有多个根因**:是。四个现象独立,分属初始化时序 / 正则敏感度 / 截断策略 / 生命周期常量。

## 4. 影响面

- **影响范围**:3.1 影响所有读 session 的工具(execute_command/batch/watch 的 cwd);3.2 影响 write_file;3.3 影响所有命令工具的大输出场景;3.4 影响关闭时的数据持久化
- **潜在受害模块**:
  - 3.1 修复涉及 session 实例化方式,需评估对 index.ts 启动流程和现有测试(测试里 `new SessionStore2()` 等)的影响
  - 3.3 修复若改 execute_command 的 outputSchema 加 truncated 字段,触发 AGENTS.md "禁止破坏工具契约"红线——需用户授权。不改 schema 则只能改 error message
  - 3.2 修复若降正则敏感度,可能漏拦真密钥(误报与漏报权衡)
- **数据完整性风险**:3.4 有(退出丢日志/会话);3.1 有(首次命令跑错目录可能导致误操作);3.3 无(只是丢输出);3.2 无(误拦不丢数据)
- **严重程度复核**:维持 P2。3.1 概率触发且仅影响首次命令目录,3.2 误报可绕过(改内容),3.3 大输出场景,3.4 概率

## 5. 修复方案

### 现象 3.1(session 竞态)

#### 方案 A:加 `awaitLoaded()` 同步点,index 启动时 await

- **做什么**:SessionStore 暴露 `loaded: Promise<void>`(构造时创建的加载 promise);index.ts 在 `server.connect` 前 `await session.loaded`。loadFromDisk 返回的 promise 存到实例字段
- **优点**:最小改动,不改实例化方式,只加一个 await 点;测试不受影响(构造仍同步)
- **缺点 / 风险**:需确保 loaded promise 在构造时即赋值;legacy 加载路径的 catch 链要正确 resolve
- **影响面**:`session.ts`、`index.ts`(加 await)

#### 方案 B:延迟实例化 + 工厂函数

- **做什么**:改为 `createSession()` 工厂,返回 `Promise<SessionStore>`,index await
- **优点**:彻底
- **缺点 / 风险**:改动大,所有 import `session` 的地方都要改(工具模块顶层 import),破坏现有代码结构
- **影响面**:全项目,违反改动最小化

**推荐方案 A**(3.1)。改动最小,只加 await 点

### 现象 3.2(scanContent 误报)

#### 方案 A:提高阈值 + 加环境变量 override

- **做什么**:Generic API Key 正则阈值从 `{16,}` 提到 `{32,}`(主流 API key 均 ≥32);加 `MCP_ALLOW_SECRET_WRITE=1` 环境变量,write_file 检测到则跳过 scanContent(allowlist override)
- **优点**:降低误报;override 给开发者逃生通道
- **缺点 / 风险**:提阈值可能漏拦 16-31 字符的真 key(罕见);override 可能被滥用(但需环境变量,非 LLM 可控)
- **影响面**:`scan.ts`、`files.ts`

#### 方案 B:只提阈值,不加 override

- **做什么**:Generic API Key 阈值提 `{16,}` → `{32,}`;Connection String 正则加 `^(?!.*localhost)` 排除本地
- **优点**:零新机制
- **缺点 / 风险**:无 override,真误报仍阻断
- **影响面**:`scan.ts`

**推荐方案 B**(3.2)。理由:override 机制引入新的安全旁路,与 hardBlock 精神冲突;提阈值 + 排除本地连接串是纯正则收紧,风险低

### 现象 3.3(截断丢数据)

#### 方案 A:保留部分输出 + 错误 message 带截断标志(不改 schema)

- **做什么**:stream.ts 超限后仍 push 当前 chunk(截到 maxOut 边界),保留已收集部分;command.ts truncated 时仍返回 fail,但 message 改为 `"output truncated at N bytes; partial:\n<前 500 字>"`
- **优点**:不改 outputSchema,不触发契约红线;LLM 拿到部分输出可诊断
- **缺点 / 风险**:截断仍是 isError=true,客户端可能仍当失败
- **影响面**:`stream.ts`、`command.ts`

#### 方案 B:截断改 success + outputSchema 加 truncated 字段

- **做什么**:truncated 时返回 success(partial stdout + truncated=true),outputSchema 加 `truncated: z.boolean().optional()`
- **优点**:语义正确(截断不是错误)
- **缺点 / 风险**:**改 outputSchema,触发 AGENTS.md "禁止破坏工具契约"红线**,需用户显式授权
- **影响面**:`command.ts`、`stream.ts`,契约变更

**推荐方案 A**(3.3)。不改 schema,不触发红线。LLM 通过 error message 的 partial 也能诊断。方案 B 更正确但需授权改契约,本 issue 不擅自突破红线

### 现象 3.4(退出窗口)

#### 方案 A:加大退出窗口 + 显式 flush

- **做什么**:`index.ts:82` 500ms → 3000ms;shutdown 里把 session.flush / audit.flush 改 await(已 await 但 500ms 兜底)
- **优点**:简单,给足写盘时间
- **缺点 / 风险**:退出响应变慢 2.5s(可接受)
- **影响面**:`index.ts` 单文件

**推荐方案 A**(3.4)。单常量改 + 已有 await

## 推荐方案汇总

| 现象 | 推荐方案 | 改动文件 | 是否触红线 |
|---|---|---|---|
| 3.1 session 竞态 | 方案 A:加 loaded promise + await | session.ts、index.ts | 否 |
| 3.2 scanContent 误报 | 方案 B:提阈值 + 排除本地连接串 | scan.ts | 否 |
| 3.3 截断丢数据 | 方案 A:保留部分 + error 带 partial(不改 schema) | stream.ts、command.ts | 否 |
| 3.4 退出窗口 | 方案 A:500ms → 3000ms | index.ts | 否 |

共同特点:全部不触发 AGENTS.md 工具契约红线、不引入新依赖、改动局部。3.3 故意选不改 schema 的方案以规避红线。
