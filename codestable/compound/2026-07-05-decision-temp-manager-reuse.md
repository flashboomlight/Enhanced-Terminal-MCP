---
doc_type: decision
category: architecture
date: "2026-07-05"
slug: temp-manager-reuse
status: active
area: temp-runtime
tags: [temp-manager, paging, ttl, lru]
updated: "2026-08-22"
description: 命令输出分页、未来编辑快照等临时资源都复用同一个 TempManager，统一 TTL + LRU 回收
---

# Decision: 临时资源统一由 TempManager 管理

## 背景

分页缓存、编辑快照、归档中转都可能产生临时文件。如果各自维护目录和清理逻辑，会出现重复代码和清理死角。

## 决定

所有临时资源都通过 `TempManager.create(subtype)` 创建，目录位于 `<projectRoot>/.etmcp/temp/`；状态根和 `temp` 根都按需创建，server 启动、stats 或 cleanup 不会无条件建立 `temp/`。
每个子类型使用不同前缀（`page-cache`、`edit-snapshot`、`archive-tmp`），统一 TTL + LRU 回收。

需要持久化的输出先使用 `createStaging()` 获取 reservation 和 heartbeat lease，成功后再原子 finalize；失败路径必须 discard staging 并释放 reservation。M2 已接通 staging writer 与 page cache v2（`stdout.bin`/`stderr.bin`/`stdout.idx`/`meta.json`），legacy 文本 cache 不再生产写入。

## 理由

- 单一回收策略，避免磁盘堆积
- 子类型前缀便于人工排查
- `TempManager` 可实例化，测试可隔离

## 影响

- 新增临时资源无需再写清理逻辑
- 环境变量 `MCP_TEMP_TTL_MS` / `MCP_MAX_TEMP_DIRS` 全局生效
- 子类型之间共享数量上限，超限时按全局 LRU 淘汰

## 相关实现

- `src/temp-manager.ts`
- `src/paging.ts`
- `codestable/features/2026-08-20-command-output-spill-paging/`
