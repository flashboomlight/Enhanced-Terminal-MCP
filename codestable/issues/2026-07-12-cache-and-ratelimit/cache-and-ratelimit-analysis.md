---
doc_type: issue-analysis
issue: 2026-07-12-cache-and-ratelimit
status: confirmed
root_cause_type: logic
related: [cache-and-ratelimit-report.md]
tags: [cache, ratelimit, security, correctness]
---

# 缓存与限流缺陷 根因分析

## 1. 问题定位

| 关键位置 | 说明 |
|---|---|
| `src/wrap.ts:21` | `cacheKey = ${toolName}:${JSON.stringify(args)}` — JSON.stringify 对对象键序敏感 |
| `src/cache.ts:18-20` | `LRUCache.key` 同样用 JSON.stringify,与 wrap.ts 一致 |
| `src/cache.ts:112-120` | `CACHEABLE_TOOLS` 名单含 read_file,缓存其返回的 CallToolResult(含文件内容) |
| `src/tools/command.ts:126-128` | execute_command 调 checkRateLimit;但 batch_execute(:305-390)未调 |
| `src/tools/command.ts:352-362` | batch_execute 并发 4,无 rateLimit 调用 |
| `src/wrap.ts:49` | `if (cacheKey && result.ok) toolCache.set(...)` — 无断言约束 CACHEABLE_TOOLS 名单 |
| `src/ratelimit.ts:71` | commandRateLimit = TokenBucket(10, 20) — burst 20, refill 10/s |
| `src/security.ts:37-54` | SENSITIVE_FILE_PATTERNS 含 `\.env(\..+)?$`,覆盖 .env.local 等 |

## 2. 失败路径还原

### 现象 2.1(缓存键序敏感 + 敏感内容)

**正常路径**:LLM 调 read_file({file_path:"/a",offset:1})→ JSON.stringify 生成 `"read_file:{\"file_path\":\"/a\",\"offset\":1}"` → 缓存命中或写入 → 复用

**失败路径 A(键序)**:客户端两次发同参数但键序不同 → JSON.stringify 产出不同字符串 → 两次 miss,缓存失效

**分叉点 A**:`src/cache.ts:19` `JSON.stringify(args)` — 无键序归一化

**失败路径 B(敏感内容)**:read_file 读一个**非敏感文件名但含密钥内容**的文件(如项目内 `config.json` 里有 API token)→ validatePath 放行(文件名不在 SENSITIVE_FILE_PATTERNS)→ 内容进入 LRU 缓存 30s

**分叉点 B**:`src/cache.ts:113` read_file 在 CACHEABLE_TOOLS —— 缓存实体含完整文件内容,无内容级扫描

**重要修正**:report 提到"`.env` 被放行"是错的——`.env`/`.env.local` 被 SENSITIVE_FILE_PATTERNS 拦。实际风险只在"文件名非敏感但内容含密钥"的边缘场景。风险存在但低于 report 描述。

### 现象 2.2(batch 绕过限流)

**正常路径**:LLM 调 execute_command(cmd)→ checkRateLimit 消费 1 token → 超过 10 req/s 被拦

**失败路径**:LLM 调 batch_execute([cmd×20],parallel=true)→ 全程无 checkRateLimit → 5 批×4 并发 spawn,瞬时 20 个进程

**分叉点**:`src/tools/command.ts:305` batch_execute handler 入口未调 checkRateLimit,直接进 execOne 循环

### 现象 2.3(无断言)

**正常路径**(当前):CACHEABLE_TOOLS 名单正确,只含只读工具 → wrapHandler 缓存写入安全

**失败路径**(假设未来误加 write_file):append 模式第二次调用命中缓存返回旧结果,实际未写

**分叉点**:`src/wrap.ts:49` 无断言约束"只读工具才能进 CACHEABLE_TOOLS",依赖人工维护

## 3. 根因

**根因类型**:logic(键序未归一化)+ missing-guard(限流/断言缺失)

**根因描述**:

三个现象各自独立:
- **2.1 键序**:JSON.stringify 对对象属性顺序敏感,而 MCP 客户端不保证参数键序,导致同参数不同键序的缓存 miss。这是 JS 对象序列化的固有特性,需在构造 key 时做键序归一化
- **2.1 敏感内容**:read_file 缓存了完整文件内容,文件名级 validatePath 放行了非敏感名但含密钥的文件。文件名黑名单无法覆盖内容级敏感(黑名单本就不可判定)
- **2.2 限流绕过**:batch_execute handler 复用了 buildShellArgs/spawnStream,但漏掉了 execute_command 入口的 checkRateLimit 调用。限流是命令工具的安全网,batch 作为批量入口绕过了它
- **2.3 无断言**:wrapHandler 的缓存写入正确性完全依赖 CACHEABLE_TOOLS 名单人工维护,无运行时或编译期约束

**是否有多个根因**:是。三个现象各自独立,但同属"缓存/限流中间件层防御不足"。

## 4. 影响面

- **影响范围**:2.1 影响所有 CACHEABLE_TOOLS(7 个只读工具)的缓存命中率;2.2 影响 batch_execute;2.3 影响 CACHEABLE_TOOLS 名单维护
- **潜在受害模块**:
  - 键序归一化若改 cache.ts 的 key 函数,影响所有缓存工具——需确保归一化不破坏现有命中
  - batch_execute 加限流需决定"按批计 1 token"还是"按条计 N token"——影响并行批的并发度
  - read_file 缓存敏感内容风险实际较低(文件名黑名单已拦常见密钥文件),修复优先级可降
- **数据完整性风险**:无(缓存 miss 只是性能损失;batch 限流只是没拦;2.3 当前不触发)
- **严重程度复核**:维持 P2。2.1 敏感内容风险修正后低于 report 描述;2.2 限流绕过是真实缺陷但不致数据损坏;2.3 是潜在防御缺失

## 5. 修复方案

### 现象 2.1(键序敏感 + 敏感内容)

#### 方案 A:键序归一化 + read_file 不缓存敏感路径

- **做什么**:
  1. `LRUCache.key` 改为对 args 做键序归一化后再 stringify(递归排序对象 keys)
  2. read_file 写缓存前检查 `isSensitivePath(file_path)`,命中则不缓存
- **优点**:键序问题彻底解决;敏感路径不进缓存
- **缺点 / 风险**:递归排序对嵌套对象有开销(缓存键构造本是热路径);isSensitivePath 已在 read_file handler 内调过一次 validatePath(间接),重复检查
- **影响面**:`cache.ts`(key 函数)、`wrap.ts`(或 files.ts read_file 处加敏感路径判断)

#### 方案 B:只修键序,不处理敏感内容

- **做什么**:只做键序归一化,不动敏感内容缓存
- **优点**:改动最小
- **缺点 / 风险**:敏感内容缓存风险仍在(虽低)
- **影响面**:`cache.ts` 单文件

**推荐方案 A**(2.1)。键序归一是核心修复;敏感路径不缓存成本低且关闭一个真实(虽低)风险面。read_file 的敏感路径检查可复用已有 `isSensitivePath`

### 现象 2.2(batch 绕过限流)

#### 方案 A:batch 按 commands 数消费 token

- **做什么**:batch_execute 入口调 `commandRateLimit.tryConsume(commands.length)`,不足则返回限流错误
- **优点**:与 execute_command 语义一致(每条命令 1 token),严格
- **缺点 / 风险**:batch 本就是为批量,按条计可能让正常批量也被拦(burst 20 不够)。需调整 burst 或加 batch 专用 bucket
- **影响面**:`command.ts` batch handler

#### 方案 B:batch 按批消费 1 token

- **做什么**:batch_execute 入口调 `checkRateLimit(commandRateLimit, "batch_execute")` 消费 1 token
- **优点**:简单,batch 作为一次调用计 1 token
- **缺点 / 风险**:20 条命令只消费 1 token,限流力度弱于单条 execute×20,仍有刷爆风险(虽降一个量级)
- **影响面**:`command.ts` batch handler

#### 方案 C:batch 按并发度消费

- **做什么**:消费 `min(commands.length, 4)` token(并发上限)
- **优点**:与实际 spawn 进程数对齐
- **缺点 / 风险**:语义不如方案 A 直观
- **影响面**:`command.ts` batch handler

**推荐方案 B**(2.2)。理由:batch 作为一次 LLM 调用计 1 token,与"LLM 循环刷爆系统"的限流目的一致(防 LLM 循环,不是防单次批量)。方案 A 过严会让正常批量不可用。同时修正 execute_command 限流错误提示文案("Wait 200ms" → 与 token bucket 对齐)

### 现象 2.3(无断言)

#### 方案 A:加运行时断言 + 注释约束

- **做什么**:在 `wrapHandler` 缓存写入处加注释约束"CACHEABLE_TOOLS 只能含 readOnlyHint 工具";可选加 dev 模式断言检查 `CACHEABLE_TOOLS` 名单的工具 annotations.readOnlyHint
- **优点**:防御性,不改行为
- **缺点 / 风险**:运行时断言增加开销;注释无强制力
- **影响面**:`wrap.ts` 或 `cache.ts`

#### 方案 B:只加注释约束

- **做什么**:仅在 CACHEABLE_TOOLS 定义处加注释"只读工具,禁止加入 write/delete 类"
- **优点**:零开销零风险
- **缺点 / 风险**:无强制力
- **影响面**:`cache.ts` 注释

**推荐方案 B**(2.3)。理由:运行时断言在热路径加开销不值;注释约束已能提醒未来维护者。本项是潜在缺陷非实际 bug,最小化处理合适

## 推荐方案汇总

| 现象 | 推荐方案 | 改动文件 |
|---|---|---|
| 2.1 键序+敏感内容 | 方案 A:键序归一化 + read_file 敏感路径不缓存 | `cache.ts`、`wrap.ts` |
| 2.2 batch 限流 | 方案 B:batch 按批消费 1 token + 修提示文案 | `command.ts` |
| 2.3 无断言 | 方案 B:注释约束 | `cache.ts` |

共同特点:不破坏工具输入输出契约、不引入新依赖、改动集中在中间件层。
