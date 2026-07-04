---
name: atomic-file-write
description: 写关键状态文件时先写 .tmp 再 rename，避免过程中断导致文件损坏
metadata:
  type: trick
---

# Trick: 原子文件写入

## 场景

`session.json` 是服务重启后恢复状态的关键文件。如果写入过程中进程崩溃，文件可能处于半写状态。

## 做法

```ts
const tmpFile = `${stateFile}.tmp`;
await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), "utf-8");
await fs.rename(tmpFile, stateFile);
```

`rename` 在大多数文件系统上是原子操作。

## 收益

- 读到的文件要么是旧版本，要么是新版本，不会损坏
- 崩溃后遗留的 `.tmp` 文件不影响读取
- 实现简单，无需额外依赖

## 相关文件

- `src/session.ts`
