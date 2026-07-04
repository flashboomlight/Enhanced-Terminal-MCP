---
name: state-dir-centralization
description: 把会话状态、审计日志、临时资源集中到一个可配置的状态目录，避免散落在系统临时目录
metadata:
  type: decision
---

# Decision: 统一状态目录

## 背景

之前会话状态文件直接落在系统临时目录（`os.tmpdir()`），导致：
- 不同工作目录共用同一份会话，行为混乱
- 临时文件与状态文件混放，难以清理
- 无法通过项目级 `.gitignore` 统一忽略

## 决定

在项目工作目录下创建 `.enhanced-terminal-mcp/`，集中存放：
- `session.json`
- `logs/audit.jsonl`
- `temp/` 临时资源

通过 `MCP_STATE_DIR` 环境变量可覆盖位置。

## 权衡

| 方案 | 优点 | 缺点 |
|---|---|---|
| 系统临时目录 | 不污染项目 | 多项目冲突、重启后丢失 |
| 项目目录 | 与工作区绑定、可 gitignore | 每个项目多一份 |

选择项目目录，因为 Terminal MCP 的使用场景与“当前工作区”强相关。

## 影响

- 需要迁移旧状态文件（Phase 1 已实现）
- 测试必须隔离 `MCP_STATE_DIR`
- `.gitignore` 需要添加 `.enhanced-terminal-mcp/`

## 相关实现

- `src/state-dir.ts`
- `codestable/features/2026-07-05-state-directory-migration/`
