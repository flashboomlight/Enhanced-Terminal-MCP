# Feature: 审计日志

## 实现结果

审计日志系统已实现，支持结构化记录关键操作并通过 MCP resource 查询。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/audit.ts` | 新增：审计日志写入、读取、轮转、`AuditLog` 可实例化类 |
| `src/tools/command.ts` | 命令执行埋点（成功/失败/超时/危险模式拦截） |
| `src/tools/files.ts` | `write_file` 埋点 |
| `src/tools/manage.ts` | `copy_move` / `delete_path` 埋点 |
| `src/tools/utility.ts` | `cache_invalidate` / `session_state` 埋点 |
| `src/security.ts` | 路径拦截埋点 |
| `src/index.ts` | 注册 `audit://log` 资源；关闭时 flush audit |
| `src/state-dir.ts` | 新增 `resetStateDirCache()` 测试辅助 |
| `src/audit.test.ts` | 新增审计测试 |

## 验证

- [x] `npm run build` 成功
- [x] `npx tsc --noEmit` 无错误
- [x] `npm run lint` 0 warnings / 0 errors
- [x] `npm test` 553/553 通过
- [x] `audit://log` 资源已注册

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_AUDIT_MODE` | `errors` | 审计模式：`off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | 最大保留条目数 |
