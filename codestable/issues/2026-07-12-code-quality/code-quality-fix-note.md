---
doc_type: issue-fix
issue: 2026-07-12-code-quality
path: standard
fix_date: 2026-07-12
related: [code-quality-analysis.md]
tags: [test-coverage, dead-code, maintainability]
---

# 代码质量缺陷 修复记录

## 1. 实际采用方案

三处采用 analysis 推荐方案(4.1 用 A、4.2 用 B、4.3 用 A):

- **4.1(测试缺口)**:在 `src/temp-manager.test.ts` 补 3 个边界测试:scan 容忍损坏 `.meta.json`、LRU 不超 max 不淘汰、LRU 超 max 淘汰 lastAccessedAt 最旧的
- **4.2(processPool dead code)**:`src/pool.ts` 顶部加注释标注 acquire/release 未接入 command.ts,说明当前仅 stats/生命周期被用,激活需评估状态污染
- **4.3(env 解析重复)**:`src/utils.ts` 新增 `envInt(name, default, min)` 统一工具;替换 temp-manager.ts(3 处)+ audit.ts(1 处)的 env 解析

### 4.3 的实现边界

command.ts 的 `getCommandMaxOutputBytes` 语义与 envInt 不完全匹配(它是 clamp 到 1024,envInt 是 reject 小于 min 返 default),保留原样未替换——analysis 已说明。

## 2. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/utils.ts` | 新增 `envInt(name, defaultVal, min)` 函数 |
| `src/temp-manager.ts` | 3 个 env 解析函数改用 envInt |
| `src/audit.ts` | `getMaxAuditEntries` 改用 envInt |
| `src/pool.ts` | 顶部加注释标注预热复用未激活 |
| `src/temp-manager.test.ts` | 补 3 个边界测试(scan 损坏、LRU 不超限、LRU 淘汰最旧) |

未触碰 analysis 范围外文件。

## 3. 验证结果

### build / lint

- `npx tsc --noEmit` 通过
- `npm run lint` 通过
- `npm run build` 通过

### 单元测试

- `src/temp-manager.test.ts`:12 passed(原 9 + 新增 3)
- 全量 `npm test`:28 文件 / **387 测试全过**(比上轮多 3 个新测试)

### envInt 行为验证

自建脚本 6 项检查全过:正常值/未设置/空串/0 小于 min/非数字/小于 min 各路径语义与原 `parseInt(env||"default") || default + Math.max` 一致。

### 新增测试覆盖的边界

- ✓ scan 读损坏 `.meta.json`(`{not valid json`)不崩,目录仍被扫描,createdAt 用默认值
- ✓ LRU 恰好等于 max 时不淘汰(只 TTL 淘汰,TTL 内不触发)
- ✓ LRU 超 max 时按 lastAccessedAt 淘汰最旧(touch 制造明确顺序,断言被删的是 lastAccessedAt 最小的)

## 4. 遗留事项

1. **command.ts 的 getCommandMaxOutputBytes 未用 envInt**:语义是 clamp(Math.max(1024, val))而非 reject,与 envInt 不匹配。保留原样。若未来 envInt 加 clamp 模式可统一
2. **processPool 预热复用仍是 dead code**:方案 B 只标注未激活,未删 acquire/release。是否激活(让 command.ts 用池)是 high-risk 改动,需独立评估,超本 issue 范围
3. **测试覆盖仍非完备**:本次只补 temp-manager 的 LRU/scan 边界。其他模块(pool acquire/release、scan.ts 各正则的边界)仍无测试,可后续按需补
