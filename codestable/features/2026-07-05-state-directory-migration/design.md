---
name: state-directory-migration
status: implemented
created: 2026-07-05
---

# Feature: 状态目录迁移

## 背景

当前会话状态文件硬编码在系统临时目录：

```ts
const STATE_FILE = path.join(tmpdir(), ".enhanced-terminal-mcp-session.json");
```

这导致：
- 状态文件位置不直观，难以排查和清理
- 与项目工作目录分离，不符合 CodeStable 对项目资产的组织理念
- 不利于未来扩展审计日志、临时资源等本地化资产

## 目标

把会话状态持久化迁移到项目工作目录下的 `.enhanced-terminal-mcp/session.json`，并支持从旧位置迁移。

## 设计

### 目录结构

```
<project-root>/
├── .enhanced-terminal-mcp/
│   └── session.json
├── package.json
└── ...
```

### 状态目录解析

新增 `src/state-dir.ts`，职责：

1. 解析状态目录路径：
   - 优先 `MCP_STATE_DIR` 环境变量
   - 默认：`<project-root>/.enhanced-terminal-mcp`
2. 自动创建目录（如果不存在）
3. 提供 `STATE_FILE_PATH`、`LEGACY_STATE_FILE_PATH`

状态目录使用 `src/version.ts` 相同的 `__dirname` 计算方式，从 `src/session.ts` 和 `build/session.js` 都能正确解析到项目根目录。

### 会话状态文件

- 新路径：`<stateDir>/session.json`
- 旧路径：`os.tmpdir()/.enhanced-terminal-mcp-session.json`

### 迁移策略

加载时：
1. 如果新路径文件存在，直接读取
2. 如果新路径不存在且旧路径存在，读取旧文件，写入新路径，保留旧文件（不删除，避免跨版本回退丢失）
3. 如果都不存在，使用 fresh state

### 写入安全

- 先写入 `<stateDir>/session.json.tmp`
- 成功后 `fs.rename` 原子替换
- 写入失败时保留旧文件

### 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_STATE_DIR` | 项目根目录下 `.enhanced-terminal-mcp` | 状态目录绝对路径 |

## 接口不变

- `session.get()`、`session.getCwd()`、`session.setCwd()`、`session.setEnv()`、`session.pushHistory()`、`session.reset()`、`session.snapshotObj()`、`session.snapshot()` 行为不变
- `session_state` 工具的输入输出 schema 不变

## 测试

新增 `tests/state-dir.test.ts`：

1. `getStateDir()` 默认返回项目根目录下的 `.enhanced-terminal-mcp`
2. `MCP_STATE_DIR` 覆盖有效
3. 目录不存在时自动创建
4. 旧文件可迁移到新位置
5. 新文件存在时不触发迁移

更新 `upgrades.test.ts` 中依赖 `tmpdir()` 的断言（如果有）。

## 验收标准

- [ ] `npm run build` 成功
- [ ] `npx tsc --noEmit` 无错误
- [ ] `npm run lint` 0 warnings / 0 errors
- [ ] `npm test` 全部通过
- [ ] `npm run test:latency` 通过
- [ ] 启动服务后，`.enhanced-terminal-mcp/session.json` 生成
- [ ] 旧位置 `os.tmpdir()/.enhanced-terminal-mcp-session.json` 仍可被迁移读取
