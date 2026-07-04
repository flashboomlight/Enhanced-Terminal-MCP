# Feature: 状态目录迁移

## 实现结果

状态文件已从系统临时目录迁移到项目工作目录下的 `.enhanced-terminal-mcp/session.json`。

## 修改清单

| 文件 | 变更 |
|---|---|
| `src/state-dir.ts` | 新增：状态目录解析、创建、`MCP_STATE_DIR` 环境变量覆盖 |
| `src/session.ts` | 使用新路径、原子写入、旧文件迁移 |
| `.gitignore` | 忽略 `.enhanced-terminal-mcp/` |
| `src/state-dir.test.ts` | 新增：状态目录解析与覆盖测试 |

## 验证

- [x] `npm run build` 成功
- [x] `npx tsc --noEmit` 无错误
- [x] `npm run lint` 0 warnings / 0 errors
- [x] `npm test` 544/544 通过
- [x] `npm run test:latency` 23/23 通过
- [x] 状态文件生成在 `.enhanced-terminal-mcp/session.json`
- [x] 旧位置 `os.tmpdir()/.enhanced-terminal-mcp-session.json` 可迁移读取

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_STATE_DIR` | `<project-root>/.enhanced-terminal-mcp` | 状态目录绝对路径 |
