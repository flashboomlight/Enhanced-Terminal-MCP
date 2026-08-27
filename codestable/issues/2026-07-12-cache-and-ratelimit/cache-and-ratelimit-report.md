---
doc_type: issue-report
issue: 2026-07-12-cache-and-ratelimit
status: confirmed
severity: P2
summary: 缓存键序敏感/可能缓存敏感内容、batch_execute 绕过限流、wrapHandler 缓存无防御断言
tags: [cache, ratelimit, security, correctness]
---

# 缓存与限流缺陷 Issue Report

## 1. 问题现象

通过对 `src/wrap.ts`、`src/cache.ts`、`src/tools/command.ts`、`src/ratelimit.ts` 的代码审查,观察到 3 项现象:

**现象 2.1 — 缓存键序敏感且可能缓存敏感内容**

`wrapHandler`([src/wrap.ts:21](../../../src/wrap.ts#L21))与 `LRUCache.key`([src/cache.ts:18](../../../src/cache.ts#L18))用 `${toolName}:${JSON.stringify(args)}` 作缓存键。问题:
- 对象键顺序不同会 miss:`{a:1,b:2}` vs `{b:2,a:1}` 序列化结果不同,MCP 客户端不保证参数键序
- `read_file` 在 `CACHEABLE_TOOLS`([src/cache.ts:112](../../../src/cache.ts#L112))中,缓存了文件内容。若 LLM 读取含密钥的文件(如 `.env` 被路径校验放行的非黑名单文件),内容以 `CallToolResult` 形式停留在 LRU 缓存 30s,`cache_stats` 不暴露但实体在内存

**现象 2.2 — batch_execute 绕过限流**

`execute_command` 单条路径在 [command.ts:126](../../../src/tools/command.ts#L126) 调 `checkRateLimit(commandRateLimit, "execute_command")`,但 `batch_execute`([command.ts:305-390](../../../src/tools/command.ts#L305))全程**未调 `checkRateLimit`**。并行模式下一次性 spawn 4 个命令,可绕过 10 req/s 的令牌桶限流。LLM 用 batch 可瞬时刷爆系统。

且 [command.ts:128](../../../src/tools/command.ts#L128) 限流错误提示"Wait 200ms and retry"与实际 token bucket(burst=20, refill 10/s)语义不符。

**现象 2.3 — wrapHandler 缓存无防御断言**

`wrapHandler`([src/wrap.ts:49](../../../src/wrap.ts#L49))`if (cacheKey && result.ok)` 写缓存,正确性完全依赖 `CACHEABLE_TOOLS` 名单手工维护正确。`write_file`/`make_directory` 的 `idempotentHint` 标注为 true,一旦有人误把它们加进 `CACHEABLE_TOOLS`,`write_file` append 模式会返回旧缓存结果。缺少防御性断言或注释约束。

## 2. 复现步骤

### 现象 2.1 复现

1. 调 `read_file`,file_path=`/a/b` —— 正常读取
2. 调 `read_file`,file_path=`/a/b` 但参数对象在客户端序列化时键序为 `{lines, file_path, encoding}` 而非 `{file_path, encoding, lines}`
3. 观察:两次调用生成不同 cacheKey,第二次未命中缓存,重复读盘

复现频率:稳定(取决于客户端键序)

### 现象 2.2 复现

1. 调 `batch_execute`,commands=`[cmd1, cmd2, ..., cmd20]`,parallel=true
2. 观察:20 条命令分 5 批、每批 4 个并发执行,全程无 `checkRateLimit` 拦截;而等价的 20 次 `execute_command` 会被限流器拦到 10 req/s

复现频率:稳定

### 现象 2.3 复现

(假设性场景)若有人将 `write_file` 加入 `CACHEABLE_TOOLS`:
1. 调 `write_file` append 模式写文件 A,内容 "x"
2. 30s 内再调 `write_file` append "y" 到同一文件 A
3. 观察:第二次因 cacheKey 命中(参数相同)返回第一次的缓存结果,实际未执行 append

复现频率:当前不触发(CACHEABLE_TOOLS 名单正确),但无防御机制防止未来误加

## 3. 期望 vs 实际

**期望行为**:缓存键对参数键序不敏感;只读工具缓存不存放敏感文件内容;所有命令执行工具统一受限流;缓存写入有防御断言防止误配置。

**实际行为**:缓存键序敏感;`read_file` 缓存可能存敏感内容;`batch_execute` 不受限流;`wrapHandler` 缓存写入仅靠手工名单,无断言。

## 4. 环境信息

- 涉及模块 / 功能:wrap(中间件)、cache(LRU 缓存)、tools/command(batch_execute)、ratelimit(令牌桶)
- 相关文件 / 函数:
  - `src/wrap.ts:21,49` — cacheKey 构造与缓存写入
  - `src/cache.ts:18,112` — `LRUCache.key`、`CACHEABLE_TOOLS`
  - `src/tools/command.ts:126,305-390` — execute_command 限流调用、batch_execute 缺限流
  - `src/ratelimit.ts:80-86` — `checkRateLimit`
- 运行环境:dev / 部署均存在
- 其他上下文:AGENTS.md 禁止破坏现有 26 个工具输入输出契约,本 issue 修复不得改工具契约

## 5. 严重程度

**P2 中等** — 现象 2.1 影响缓存命中率(性能)且有敏感内容留存风险;现象 2.2 是限流绕过(可靠性);现象 2.3 是潜在缺陷(当前未触发)。无数据破坏风险,但影响系统健壮性。计划内修。

## 备注

- 本 issue 是"缓存/限流类"3 项缺陷合集,源自系统性审查,与 security-model issue 同源
- 现象 2.1 的"缓存敏感内容"与 read_file 路径校验交互:read_file 经 `validatePath` 拦截黑名单敏感文件,但非黑名单的含密钥文件(如项目内 `.env.local` 若不在黑名单正则)可能被缓存
- 现象 2.3 是防御性编程问题,修复应加断言或注释,不改现有行为
