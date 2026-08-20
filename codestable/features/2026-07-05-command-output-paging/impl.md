---
name: command-output-paging
status: implemented
created: 2026-07-05
---

# Feature: 命令输出分页

## 实现结果

命令输出分页已实现，`execute_command` 支持 `cache_id` / `page` / `pageSize` 参数，大输出自动写入分页缓存并按页返回。`cache_id` 只接受服务生成的 `page-cache-{timestamp}-{random}` 形态，读取时会确认路径仍在临时缓存根目录内。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/paging.ts` | 新增：分页缓存，复用 `TempManager` 自动回收，并校验 `cache_id` 边界 |
| `src/paging.test.ts` | 新增：分页缓存单元测试 |
| `src/tools/command.ts` | `execute_command` 增加 `cache_id` / `page` / `pageSize`，大输出自动分页，后续页不重跑命令；命令 stdout 超过 `MCP_COMMAND_MAX_OUTPUT_BYTES` 时返回显式错误 |

## 验证

- [x] `npm run build` 成功
- [x] `npx tsc --noEmit` 无错误
- [x] `npm run lint` 0 warnings / 0 errors
- [x] `npm test` 分页测试通过
- [x] `tests/e2e-latency.test.ts` 通过

## 接口变更

`execute_command` inputSchema 增加：

```ts
{
  cache_id?: string;  // 读取既有分页缓存时使用
  page?: number;      // 默认 1
  pageSize?: number;  // 默认 2000，最大 10000
}
```

outputSchema 增加可选字段：

```ts
{
  cache_id?: string;
  page?: number;
  total_pages?: number;
  page_size?: number;
  total_chars?: number;
}
```

## 行为

- 未指定 `page` 且输出未超过 `pageSize`：返回完整输出，与旧行为一致
- 指定 `page` 或输出超过 `pageSize`：写入分页缓存，返回请求页和 `cache_id`
- 后续提供 `cache_id`：直接读取缓存页，不重新执行命令
- 无效页码返回 `VALIDATION_ERROR`
- 无效或越界 `cache_id` 返回未找到，不会解析到临时缓存根目录之外
- stdout 超过 `MCP_COMMAND_MAX_OUTPUT_BYTES` 时命令会停止并返回明确错误，避免静默截断

## 配置

复用 Phase 3 临时资源配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_TEMP_TTL_MS` | `3600000` | 分页缓存 TTL |
| `MCP_MAX_TEMP_DIRS` | `100` | 分页缓存数量上限 |
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | 单次命令 stdout 捕获上限 |

## 缓存结构

`.enhanced-terminal-mcp/temp/page-cache-{timestamp}-{random}/`：

- `.meta.json`：临时资源元数据
- `stdout.txt`：完整标准输出
- `stderr.txt`：完整标准错误
- `meta.json`：元数据
