# Feature: 状态目录迁移

## 验收结论

状态目录迁移已完成并通过全部验证。

## 验收检查项

| 检查项 | 结果 |
|---|---|
| 状态文件路径正确 | ✅ `.enhanced-terminal-mcp/session.json` |
| 目录自动创建 | ✅ 启动时自动创建 |
| 环境变量覆盖 | ✅ `MCP_STATE_DIR` 有效 |
| 旧文件迁移 | ✅ 从 `os.tmpdir()` 读取并写入新位置 |
| 原子写入 | ✅ 先写 `.tmp` 再 rename |
| 接口兼容 | ✅ `session_state` 输入输出不变 |
| build | ✅ 通过 |
| typecheck | ✅ 通过 |
| lint | ✅ 0 warnings / 0 errors |
| tests | ✅ 544/544 |
| test:latency | ✅ 23/23 |

## 备注

- 旧位置文件保留，不删除，便于版本回退
- `.gitignore` 已忽略状态目录，避免提交
