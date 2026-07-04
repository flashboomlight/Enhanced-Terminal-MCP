# Feature: 审计日志

## 验收结论

审计日志已完成并通过全部验证。

## 验收检查项

| 检查项 | 结果 |
|---|---|
| `audit.jsonl` 生成 | ✅ `.enhanced-terminal-mcp/logs/audit.jsonl` |
| 命令执行记录 | ✅ execute_command / batch_execute / watch_command |
| 文件操作记录 | ✅ write_file / copy_move / delete_path |
| 会话变更记录 | ✅ session_state |
| 安全拦截记录 | ✅ validatePath / hasDangerousPattern |
| `audit://log` 资源 | ✅ 已注册，支持 `?limit=N` |
| build | ✅ 通过 |
| typecheck | ✅ 通过 |
| lint | ✅ 0 warnings / 0 errors |
| tests | ✅ 553/553 |

## 备注

- 默认 `MCP_AUDIT_MODE=errors` 只记录失败/拦截操作，降低 I/O 开销
- `AuditLog` 类可实例化，方便测试隔离
