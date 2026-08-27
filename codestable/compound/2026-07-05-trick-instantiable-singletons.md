---
doc_type: trick
type: pattern
date: "2026-07-05"
slug: instantiable-singletons-for-tests
status: active
tags: [testing, state, singleton, isolation]
description: 对持有全局状态（state dir, audit, temp）的模块同时提供可实例化类和默认单例，便于测试隔离
---

# Trick: 可实例化类 + 默认单例

## 场景

`AuditLog`、`TempManager`、`PageCache` 都依赖全局状态目录。如果只用单例，测试之间会互相污染。

## 做法

每个模块同时暴露：
1. 一个可实例化的类（如 `AuditLog`、`TempManager`、`PageCache`）
2. 一个默认单例（如 `audit`、`tempManager`、`pageCache`）

```ts
export class AuditLog { ... }
export const audit = new AuditLog();
```

测试中使用类实例，生产代码使用单例。

## 配套

对缓存的状态目录路径提供 `resetStateDirCache()`，让 `beforeEach` 可以切换 `MCP_STATE_DIR` 后重新解析。

## 示例

```ts
beforeEach(async () => {
  process.env.MCP_STATE_DIR = await fs.mkdtemp(...);
  resetStateDirCache();
});
```

## 收益

- 测试并行/串行互不污染
- 生产代码保持简洁的单例 API
- 无需复杂的依赖注入框架

## 相关文件

- `src/state-dir.ts`
- `src/audit.ts`
- `src/temp-manager.ts`
- `src/paging.ts`
