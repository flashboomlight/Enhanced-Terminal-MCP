---
name: temp-resource-manager
status: design
created: 2026-07-05
---

# Feature: 临时资源管理器

## 背景

当前 Terminal MCP 几乎不产生临时文件，但随着审计日志、分页输出、编辑快照等功能扩展，需要一个统一的临时资源生命周期管理机制，避免磁盘堆积。

## 目标

建立 TTL + LRU 的临时资源回收机制。

## 设计

### 目录结构

```
.enhanced-terminal-mcp/
├── session.json
├── logs/
│   └── audit.jsonl
└── temp/
    ├── page-cache/
    ├── edit-snapshots/
    └── archive-tmp/
```

### 接口

新增 `src/temp-manager.ts`：

```ts
interface TempDir {
  id: string;
  dir: string;
  createdAt: number;
  lastAccessedAt: number;
}

class TempManager {
  async create(subtype: string, id?: string): Promise<TempDir>
  touch(id: string): void
  async cleanup(): Promise<{ removed: number; remaining: number }>
  stats(): TempStats
}
```

### TTL + LRU 策略

- 每个临时目录记录 `createdAt` 和 `lastAccessedAt`
- 清理时：
  1. 删除超过 `MCP_TEMP_TTL_MS` 未访问的目录
  2. 如果总数仍超过 `MCP_MAX_TEMP_DIRS`，按 `lastAccessedAt` 升序淘汰
- 服务启动和 `process.on('exit')` / `SIGTERM` 时执行清理
- 定时任务按 `MCP_TEMP_CLEANUP_INTERVAL_MS` 轮询

### 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_TEMP_TTL_MS` | `3600000`（1小时） | 临时文件 TTL |
| `MCP_MAX_TEMP_DIRS` | `100` | 最大临时目录数 |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000`（5分钟） | 清理轮询间隔 |

### 新增工具

`temp_stats`：返回临时目录统计

```ts
{
  total_dirs: number,
  total_size_bytes: number,
  oldest_dir_ms: number,
  newest_dir_ms: number,
  removed_count: number
}
```

## 依赖

依赖 Phase 1 的状态目录 `src/state-dir.ts`。

## 测试

- `tests/temp-manager.test.ts`：创建、访问刷新、TTL 清理、LRU 淘汰

## 验收标准

- [ ] 临时目录自动创建在 `.enhanced-terminal-mcp/temp/`
- [ ] 超 TTL 目录被删除
- [ ] 超数量上限按 LRU 淘汰
- [ ] `temp_stats` 工具返回正确统计
- [ ] build / lint / test / latency 全绿
