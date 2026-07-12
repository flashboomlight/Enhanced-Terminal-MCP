---
doc_type: issue-report
issue: 2026-07-12-code-quality
status: confirmed
severity: P3
summary: 多模块无测试覆盖、processPool 预热复用为 dead code、env 解析重复无缓存
tags: [test-coverage, dead-code, maintainability]
---

# 代码质量缺陷 Issue Report

## 1. 问题现象

通过 codegraph blast-radius 报告 + 代码审查,观察到 3 项现象:

**现象 4.1 — 多个核心模块无测试覆盖**

codegraph 的 blast-radius 报告标注多个核心模块 `⚠️ no covering tests found`:
- `temp-manager.ts` 的 `scan` 方法(私有,但被 init 调用)
- `validate_yaml_file`(codestable/tools/validate-yaml.py,非 src 但属项目)

实际审查发现 `src/temp-manager.ts` 的 LRU 淘汰边界([:133-141](src/temp-manager.ts#L133))、`.meta.json` 损坏恢复、`dirSize` 递归统计大目录的性能均无针对性测试。`pool.ts` 的 acquire/release 也无测试(因无人调用,见 4.2)。

**现象 4.2 — processPool 预热复用为 dead code**

`ProcessPool`([src/pool.ts](src/pool.ts))实现 shell 预热池(`acquire`/`release` 复用预热 shell)。但 grep 确认:**`acquire()`/`release()` 在 pool.ts 之外无任何调用点**。command.ts 用 `spawnStream`([command.ts:21](src/tools/command.ts#L21) `getShell()` + spawnStream)每次新 spawn,不取池里的预热 shell。

processPool 的部分功能仍被用:
- `processPool.stats` 被 `pool_stats` 工具读([utility.ts:346](src/tools/utility.ts#L346))
- `startSweep()`/`destroy()` 在 index.ts 生命周期调用

所以不是整个 processPool 是 dead code,而是其**核心价值(预热 shell 复用)未激活**——池里永远没有预热 shell,stats 永远报空池。

**现象 4.3 — env 解析重复无缓存**

`getTempTtlMs`/`getMaxTempDirs`/`getCleanupIntervalMs`([temp-manager.ts:10-19](src/temp-manager.ts#L10))、`getMaxAuditEntries`/`getAuditMode`([audit.ts:22-31](src/audit.ts#L22))、`getCommandMaxOutputBytes`([command.ts:25-31](src/tools/command.ts#L25))每次调用都 `parseInt(process.env.X || "default")`。频繁路径上多一次 env 查找 + parseInt + 代码重复。

## 2. 复现步骤

### 现象 4.1 复现

1. `codegraph explore` 或 grep 查 temp-manager.ts 的 scan 方法测试覆盖
2. 观察:无针对 LRU 淘汰边界、meta.json 损坏恢复的测试

复现频率:稳定(代码状态)

### 现象 4.2 复现

1. 启动服务器,调 `pool_stats`
2. 观察:size=0, idle=0, busy=0 —— 池永远是空的,因为无人 acquire
3. grep `\.acquire\|\.release` 确认无 src 内调用点

复现频率:稳定

### 现象 4.3 复现

1. 审查 temp-manager.ts:10-19 / audit.ts:22-31 / command.ts:25-31
2. 观察:每个 env 读取函数都是 `parseInt(process.env.X || "default")` 模式重复

复现频率:稳定(代码状态)

## 3. 期望 vs 实际

**期望行为**:核心模块有边界测试覆盖;processPool 要么被真用要么诚实标注未启用;env 解析有统一缓存层。

**实际行为**:temp-manager LRU/meta 恢复无测试;processPool 预热复用 dead code 但 stats 工具依赖它;env 解析重复散落多处。

## 4. 环境信息

- 涉及模块 / 功能:temp-manager、pool、audit、command 的 env 解析、测试套件
- 相关文件 / 函数:
  - `src/temp-manager.ts:10-19,60,133-141` — env 解析、scan、LRU 淘汰
  - `src/pool.ts:36,72` — acquire/release(无调用点)
  - `src/tools/utility.ts:346` — pool_stats 依赖 stats
  - `src/audit.ts:22-31`、`src/tools/command.ts:25-31` — env 解析重复
- 运行环境:dev / 部署均存在
- 其他上下文:AGENTS.md 禁止破坏 26 个工具契约——pool_stats 是其中之一,不能删 processPool

## 5. 严重程度

**P3 轻微** — 4.1 是测试覆盖缺口(无运行时 bug);4.2 是 dead code(浪费但无害);4.3 是代码重复(性能影响微乎其微)。均不影响功能正确性,属可维护性改进。按空闲修。

## 备注

- 现象 4.2 的修复需权衡:激活 processPool(让 command.ts 用池)会改变命令执行路径,可能引入新问题;诚实标注未启用 + 简化更稳。两种方向在 analysis 详述
- 现象 4.1 的测试补充应聚焦"有运行时风险"的边界(LRU 淘汰、meta 损坏恢复),而非追求覆盖率数字
- 现象 4.3 可提取统一 `envInt(name, default, min)` 工具函数,消除重复
