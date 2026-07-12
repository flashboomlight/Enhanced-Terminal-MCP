---
doc_type: issue-analysis
issue: 2026-07-12-code-quality
status: confirmed
root_cause_type: missing-guard
related: [code-quality-report.md]
tags: [test-coverage, dead-code, maintainability]
---

# 代码质量缺陷 根因分析

## 1. 问题定位

| 关键位置 | 说明 |
|---|---|
| `src/temp-manager.ts:60-86` | `scan` 私有方法,init 时调,无测试覆盖其读取/损坏恢复路径 |
| `src/temp-manager.ts:133-141` | LRU 淘汰边界逻辑,无针对"超过 maxTempDirs 时淘汰最旧"的测试 |
| `src/temp-manager.ts:193-211` | `dirSize` 递归统计,无大目录性能/异常文件测试 |
| `src/pool.ts:36` | `acquire()` 定义,src 内无调用点 |
| `src/pool.ts:72` | `release()` 定义,src 内无调用点 |
| `src/tools/utility.ts:346` | `pool_stats` 工具读 `processPool.stats`,依赖 pool 存在 |
| `src/temp-manager.ts:10-19` | 3 个 env 解析函数重复 `parseInt(process.env.X \|\| "default")` |
| `src/audit.ts:22-31` | 2 个 env 解析函数同模式 |
| `src/tools/command.ts:25-31` | `getCommandMaxOutputBytes` 同模式 |

## 2. 失败路径还原

### 现象 4.1(测试缺口)

**正常路径**(有测试):temp-manager 的 create/stats/cleanup 基础路径被现有测试覆盖

**失败路径**(无测试):scan 读到损坏 `.meta.json`(非 JSON)→ applyState 用默认值 → 但 LRU 淘汰边界(maxTempDirs 超限时按 lastAccessedAt 排序淘汰最旧)从未被测试验证 → 边界 off-by-one 或排序错误不会被发现

**分叉点**:测试套件未覆盖 scan 的损坏恢复 + LRU 淘汰边界。这些是有运行时风险的路径(状态污染)

### 现象 4.2(processPool dead code)

**正常路径**(设计意图):command 工具 acquire 预热 shell → 执行 → release 回池 → 下次复用,省去 spawn 开销

**失败路径**(实际):command.ts 直接 spawnStream 每次新 spawn → processPool.acquire 从未被调 → 池永远空 → pool_stats 报 size=0 → 预热 shell 的 spawn 开销白付(实际没付,因为 acquire 是惰性的)

**分叉点**:command.ts 入口选了 spawnStream 而非 pool.acquire。pool 的核心价值未激活

### 现象 4.3(env 解析重复)

**正常路径**:每个 env 函数独立 `parseInt(process.env.X || "default")`,每次调用重算

**失败路径**:不是 bug,但 5+ 处重复同一模式,新增 env 配置时易写错(如忘记 `|| default` 或 `Math.max` 下限)

**分叉点**:无统一 env 解析工具,模式散落

## 3. 根因

**根因类型**:missing-guard(4.1 测试缺口)+ 设计未完成(4.2 池未接入)+ 重复代码(4.3)

**根因描述**:

- **4.1**:测试套件覆盖了 happy path,但遗漏了 temp-manager 的状态恢复(scan 损坏 meta)和 LRU 淘汰边界。这些是状态污染高风险路径
- **4.2**:ProcessPool 实现完整但从未接入 command.ts 的执行路径。可能是早期实现后执行路径改用 spawnStream,池被遗留。pool_stats 工具依赖 stats,所以不能直接删
- **4.3**:env 解析模式重复散落 5+ 处,无统一工具函数

**是否有多个根因**:是。三个独立现象,同属"可维护性"。

## 4. 影响面

- **影响范围**:4.1 影响测试套件质量;4.2 影响 pool.ts 维护负担;4.3 影响新增 env 配置的易错性
- **潜在受害模块**:
  - 4.2 若激活 processPool(让 command.ts 用池),改变命令执行路径,可能引入并发/状态问题;若简化标注,需保留 stats 给 pool_stats
  - 4.3 提取统一函数影响所有 env 解析点,需确保不改变现有语义(如下限、默认值)
- **数据完整性风险**:4.1 的 LRU 淘汰边界若有 bug 可能误删 temp 目录(但 temp 是可回收的,风险低);4.2/4.3 无
- **严重程度复核**:维持 P3。均无运行时 bug,纯可维护性

## 5. 修复方案

### 现象 4.1(测试缺口)

#### 方案 A:补 temp-manager 边界测试

- **做什么**:在 `src/temp-manager.test.ts` 补 3 类测试:(1)scan 读损坏 `.meta.json` 用默认值不崩;(2)LRU 淘汰——超过 maxTempDirs 时淘汰 lastAccessedAt 最旧的;(3)dirSize 遇异常文件不崩
- **优点**:覆盖有运行时风险的边界;不改产品代码
- **缺点 / 风险**:可能发现现有 bug 需连带修(届时评估是否扩范围)
- **影响面**:`src/temp-manager.test.ts`(可能小改 temp-manager.ts 若发现 bug)

#### 方案 B:只补 scan 损坏恢复测试

- **做什么**:只测 scan 读损坏 meta 不崩,LRU/dirSize 暂不测
- **优点**:最小改动
- **缺点 / 风险**:LRU 边界仍无覆盖
- **影响面**:`src/temp-manager.test.ts`

**推荐方案 A**(4.1)。LRU 淘汰边界是有运行时风险的状态污染路径,值得测

### 现象 4.2(processPool dead code)

#### 方案 A:激活 processPool,command.ts 用池

- **做什么**:command.ts 的 buildShellArgs 改为从 pool.acquire 取预热 shell,执行完 release
- **优点**:激活 dead code,实现预热复用价值
- **缺点 / 风险**:**改变命令执行路径**,可能引入并发/状态问题;预热 shell 有状态(chcp/环境变量)可能污染后续命令;改动大且 high-risk
- **影响面**:`command.ts`、`pool.ts`,执行路径变更

#### 方案 B:诚实标注未启用 + 简化

- **做什么**:pool.ts 顶部加注释标注"预热复用未接入 command.ts,当前仅 stats 被用";不删 acquire/release(保留给未来);pool_stats 工具说明里加"池未激活"
- **优点**:零运行时风险;诚实反映状态
- **缺点 / 风险**:dead code 仍在
- **影响面**:`pool.ts` 注释、`utility.ts` 工具描述

#### 方案 C:删除 processPool,pool_stats 改读 spawnStream 统计

- **做什么**:删 pool.ts,pool_stats 工具改为报"无进程池,使用按需 spawn"
- **优点**:彻底清 dead code
- **缺点 / 风险**:破坏 pool_stats 工具语义(虽不删工具但改其输出),触及 AGENTS.md 工具契约红线
- **影响面**:`pool.ts`、`utility.ts`、`index.ts`,契约变更

**推荐方案 B**(4.2)。理由:方案 A 改执行路径 high-risk 超出 code-quality issue 范围;方案 C 触契约红线。方案 B 零风险诚实标注,dead code 留待未来决定是否激活

### 现象 4.3(env 解析重复)

#### 方案 A:提取统一 `envInt` 工具函数

- **做什么**:在 utils.ts 或新建 env.ts 加 `envInt(name, defaultVal, min=1)`,替换 5+ 处重复
- **优点**:消除重复,新增 env 配置不易写错
- **缺点 / 风险**:需确保语义完全一致(下限、默认值、NaN 处理)
- **影响面**:`utils.ts`/新文件 + 5 处调用点

#### 方案 B:不提取,只加注释模板

- **做什么**:不动代码
- **优点**:零风险
- **缺点 / 风险**:重复仍在
- **影响面**:无

**推荐方案 A**(4.3)。提取统一函数是标准重构,风险可控

## 推荐方案汇总

| 现象 | 推荐方案 | 改动文件 | 是否触红线 |
|---|---|---|---|
| 4.1 测试缺口 | 方案 A:补 LRU/scan/dirSize 边界测试 | temp-manager.test.ts | 否 |
| 4.2 processPool | 方案 B:诚实标注未启用 + 注释 | pool.ts、utility.ts | 否 |
| 4.3 env 解析 | 方案 A:提取 envInt 工具 | utils.ts + 5 处调用 | 否 |

共同特点:不破坏工具契约、不引入新依赖、不改命令执行路径(规避 4.2 方案 A 的 high-risk)。
