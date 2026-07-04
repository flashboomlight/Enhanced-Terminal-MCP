# Feature: 命令输出分页

## 验收结论

命令输出分页已完成并通过全部验证。

## 验收检查项

| 检查项 | 结果 |
|---|---|
| `execute_command` 支持 `page` / `pageSize` | ✅ |
| 大输出自动分页缓存 | ✅ 输出超过 pageSize 时写入 `temp/page-cache` |
| 翻页内容正确 | ✅ 单测覆盖第 1 页、第 2 页、无效页码 |
| 不指定分页时行为不变 | ✅ 小输出直接返回完整内容 |
| build | ✅ 通过 |
| typecheck | ✅ 通过 |
| lint | ✅ 0 warnings / 0 errors |
| tests | ✅ e2e-latency + paging 通过 |

## 备注

- 默认 `pageSize` 2000，最大 10000
- 缓存目录由 `TempManager` TTL/LRU 自动回收
