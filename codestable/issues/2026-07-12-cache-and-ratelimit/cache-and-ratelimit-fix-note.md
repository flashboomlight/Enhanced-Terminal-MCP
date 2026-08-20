---
doc_type: issue-fix
issue: 2026-07-12-cache-and-ratelimit
path: standard
fix_date: 2026-07-12
related: [cache-and-ratelimit-analysis.md]
tags: [cache, ratelimit, security, correctness]
---

# 缓存与限流缺陷 修复记录

## 1. 实际采用方案

三处采用 analysis 推荐方案(2.1 用 A、2.2 用 B、2.3 用 B),但 2.1 做了实现调整:

- **2.1(键序敏感)**:在 `LRUCache.key` 加 `stableKeySorter` replacer,递归排序对象 key 后再 stringify;`wrap.ts` 改用 `LRUCache.key()` 复用归一化逻辑
- **2.2(batch 绕过限流)**:`batch_execute` 入口加 `checkRateLimit(commandRateLimit, "batch_execute")`(按批消费 1 token);修正 `execute_command` 限流提示文案
- **2.3(无断言)**:`CACHEABLE_TOOLS` 定义处加注释约束

### 2.1 的实现调整

analysis 方案 A 原含"read_file 缓存前检查 isSensitivePath 不缓存"。实现时确认这是冗余——`read_file` handler 入口已调 `validatePath`,命中敏感路径(含 `.env`/`.env.local`/`.pem`/`.ssh` 等)直接返回 `PATH_SENSITIVE` 错误(`result.ok=false`),`wrap.ts:49` 的 `if (cacheKey && result.ok)` 不会缓存失败结果。所以文件名级敏感路径已天然不进缓存。

剩余风险"文件名非敏感但内容含密钥"(如项目内 `config.json` 含 token)属内容级检测,`read_file` 是只读、扫描其内容成本高且误报多(配置文件常含类密钥字符串),analysis 权衡后不额外处理。本 issue 只修键序归一化,内容级风险记入遗留。

## 2. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/cache.ts` | 新增 `stableKeySorter` replacer;`LRUCache.key` 用其归一化键序;`CACHEABLE_TOOLS` 加注释约束 |
| `src/wrap.ts` | import `LRUCache`;cacheKey 改用 `LRUCache.key()` |
| `src/tools/command.ts` | `execute_command` 限流提示文案修正;`batch_execute` 加 `checkRateLimit` |

未触碰 analysis 范围外文件。

## 3. 验证结果

### build / lint

- `npx tsc --noEmit` 通过(修复了 wrap.ts 通过实例访问 static 方法的 TS2576 错误)
- `npm run lint` 通过(lint:fix 自动修正 command.ts 行长格式)
- `npm run build` 通过

### 单元测试

- `src/utils.extended.test.ts` + `src/wrap.test.ts`:11 passed

### 复现步骤验证

自建脚本 6 项检查全过:

- ✓ 不同键序 `{file_path,offset}` vs `{offset,file_path}` 生成相同 cacheKey
- ✓ 嵌套对象键序归一化生效
- ✓ 数组顺序保留(非对象,不误归一化)
- ✓ read_file 可缓存 / write_file 不可缓存 / execute_command 不可缓存

batch_execute 限流通过 `grep checkRateLimit` 确认(command.ts:352)。

## 4. 遗留事项

1. **内容级敏感缓存风险**:文件名非敏感但内容含密钥的文件(如 `config.json` 含 token)仍会被 read_file 缓存。权衡成本与误报后不额外处理。若未来需要,可在 read_file handler 对小文件内容跑 `scanContent`,但需评估误报
2. **batch 按批计 1 token 的限流力度**:20 条命令只消费 1 token,弱于单条 execute×20。与"防 LLM 循环"目的一致,但单次大批量 spawn 仍可能压满系统。若需更严可改方案 A(按条计),但需同步调大 burst
