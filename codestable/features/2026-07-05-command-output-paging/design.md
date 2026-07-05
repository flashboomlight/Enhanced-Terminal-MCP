---
name: command-output-paging
status: design
created: 2026-07-05
---

# Feature: 命令输出分页

## 背景

`execute_command` 当前对 stdout 做 2000 字符硬截断，大输出会丢失尾部。需要支持分页读取，让调用方可以按需翻页。

## 目标

- 大输出自动写入分页缓存
- 通过 `cache_id` / `page` / `pageSize` 参数读取指定页
- 不指定分页时小输出保持完整返回；大输出返回第一页和分页元数据
- 缓存复用 Phase 3 临时资源管理器，自动 TTL 回收

## 设计

### 新增模块 `src/paging.ts`

```ts
export interface PageCacheEntry {
  id: string;
  file: string;
  command: string;
  cwd: string;
  exitCode: number;
  stderr: string;
  createdAt: number;
  totalChars: number;
  pageSize: number;
  totalPages: number;
}

export interface PageResult {
  content: string;
  cache_id: string;
  stderr: string;
  exit_code: number;
  page: number;
  total_pages: number;
  page_size: number;
  total_chars: number;
}

export class PageCache {
  async cache(command: string, cwd: string, exitCode: number, stdout: string, stderr: string, pageSize?: number): Promise<PageCacheEntry>
  async get(id: string, page: number, pageSize?: number): Promise<PageResult | null>
  touch(id: string): void
}
```

### 缓存文件结构

位于 `.enhanced-terminal-mcp/temp/page-cache/{id}/`：

- `stdout.txt`：完整标准输出
- `stderr.txt`：完整标准错误
- `meta.json`：命令、cwd、exitCode、创建时间、页大小、总页数

### execute_command 参数扩展

```ts
{
  command: string;
  cache_id?: string;  // 读取既有分页缓存时使用；提供后不会重新执行 command
  cwd?: string;
  timeout?: number;
  page?: number;      // 默认 1
  pageSize?: number;  // 默认 2000，最大 10000
}
```

### 行为

1. 命令执行成功后，若 `page` 指定或 stdout 长度超过默认 `pageSize`（2000）：
   - 写入分页缓存
   - 返回请求页内容 + `cache_id` / `page` / `total_pages` / `page_size` / `total_chars`
2. 若未指定 `page` 且输出未超限：
   - 返回完整输出（与现有行为一致）
   - `meta` 中不包含分页字段
3. 后续调用提供 `cache_id`：
   - 直接读取缓存页，不重新执行命令
4. 若 `page > total_pages`：返回错误 `VALIDATION_ERROR`

### 输出 schema 扩展

`execute_command` 的 outputSchema 增加可选字段：

```ts
cache_id?: string;
page?: number;
total_pages?: number;
page_size?: number;
total_chars?: number;
```

### 回收

缓存目录位于 `tempManager` 管辖范围，超 TTL 自动删除。调用 `pageCache.touch(id)` 刷新访问时间。

## 配置

复用 Phase 3 配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_TEMP_TTL_MS` | `3600000` | 分页缓存 TTL |
| `MCP_MAX_TEMP_DIRS` | `100` | 缓存数量上限 |

## 测试

- `src/paging.test.ts`：
  - 小输出未缓存直接返回
  - 大输出自动缓存并返回第一页
  - 翻页读取内容正确
  - 无效页码返回错误

## 验收标准

- [ ] `execute_command` 支持 `cache_id` / `page` / `pageSize`
- [ ] 大输出自动分页缓存
- [ ] 翻页内容正确
- [ ] 不指定分页时行为不变
- [ ] build / lint / test / latency 全绿
