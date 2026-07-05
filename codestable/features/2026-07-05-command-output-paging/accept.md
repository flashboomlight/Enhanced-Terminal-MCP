# Feature: 命令输出分页

## 验收结论

命令输出分页已完成并通过全部验证。

## 验收检查项

| 检查项 | 结果 |
|---|---|
| `execute_command` 支持 `cache_id` / `page` / `pageSize` | ✅ |
| 大输出自动分页缓存 | ✅ 输出超过 pageSize 时写入 `temp/page-cache-{timestamp}-{random}` |
| 翻页内容正确 | ✅ 单测覆盖第 1 页、第 2 页、无效页码 |
| 翻页不重新执行命令 | ✅ e2e 覆盖 `cache_id` 读取第 2 页 |
| 非法 `cache_id` 被拒绝 | ✅ 单测覆盖非生成 ID / 路径穿越形态 |
| 不指定分页时行为不变 | ✅ 小输出直接返回完整内容 |
| build | ✅ 通过 |
| typecheck | ✅ 通过 |
| lint | ✅ 0 warnings / 0 errors |
| tests | ✅ e2e-latency + paging 通过 |

## 备注

- 默认 `pageSize` 2000，最大 10000
- 分页响应返回经校验的 `cache_id`，后续页通过 `cache_id` 读取
- stdout 超过 `MCP_COMMAND_MAX_OUTPUT_BYTES` 时返回明确错误，避免静默截断
- 缓存目录由 `TempManager` TTL/LRU 自动回收
