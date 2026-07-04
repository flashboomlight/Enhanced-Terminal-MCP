---
name: temp-resource-manager
status: implemented
created: 2026-07-05
---

# Feature: 临时资源管理器

## 实现结果

临时资源管理器已实现，提供 TTL + LRU 自动回收能力，为后续分页缓存、编辑快照、归档中转提供统一临时目录生命周期管理。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/temp-manager.ts` | 新增：TTL + LRU 临时目录管理器，可实例化 `TempManager` 类 |
| `src/temp-manager.test.ts` | 新增：创建、TTL 清理、LRU 淘汰测试 |
| `src/index.ts` | 服务启动时初始化 `tempManager`，关闭时停止自动清理 |
| `src/tools/utility.ts` | 新增 `temp_stats` 工具暴露临时目录统计 |

## 验证

- [x] `npm run build` 成功
- [x] `npx tsc --noEmit` 无错误
- [x] `npm run lint` 0 warnings / 0 errors
- [x] `npm test` 556/556 通过
- [x] `temp_stats` 工具可读取

## 接口

```ts
export interface TempDir {
  id: string;
  dir: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface TempStats {
  total_dirs: number;
  total_size_bytes: number;
  oldest_dir_ms: number;
  newest_dir_ms: number;
  removed_count: number;
}

export class TempManager {
  async create(subtype: string, id?: string): Promise<TempDir>
  touch(id: string): void
  async cleanup(): Promise<{ removed: number; remaining: number }>
  async stats(): Promise<TempStats>
  stopAutoCleanup(): void
}
```

## 设计要点

- 临时目录统一位于 `.enhanced-terminal-mcp/temp/`
- 每个目录包含 `.meta.json` 记录 `createdAt` 与 `lastAccessedAt`
- `create()` 自动生成唯一 ID 并落盘 meta
- `touch()` 刷新访问时间并异步保存 meta
- `cleanup()` 先按 TTL 删除，再按 LRU 淘汰超过上限的目录
- 服务启动时 `scan()` 恢复已有目录；启动自动清理轮询
- 环境变量每次 `init()` 重新读取，便于测试覆盖

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_TEMP_TTL_MS` | `3600000` | 临时文件 TTL（毫秒），最小 1ms |
| `MCP_MAX_TEMP_DIRS` | `100` | 最大临时目录数 |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | 清理轮询间隔（毫秒），最小 60000ms |

## 已知边界

- `dirSize()` 使用 Node 20+ 的 `withFileTypes: true, recursive: true` 读取目录；旧版本 Node 可能不支持递归 `Dirent`
- 自动清理轮询在服务关闭时由 `stopAutoCleanup()` 停止
