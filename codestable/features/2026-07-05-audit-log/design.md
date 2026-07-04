---
name: audit-log
status: implemented
created: 2026-07-05
---

# Feature: 审计日志

## 背景

当前系统已有 telemetry 指标和安全拦截，但缺乏结构化审计日志来追踪谁在什么时间做了什么操作。引入审计日志可以提升可观测性、故障排查和安全合规能力。

## 目标

建立结构化审计日志，记录关键操作，并通过 MCP resource 暴露查询能力。

## 设计

### 存储位置

```
.enhanced-terminal-mcp/
├── session.json
└── logs/
    └── audit.jsonl
```

### 审计条目结构

```ts
interface AuditEntry {
  timestamp: string;      // ISO 8601
  action: string;         // 操作类型
  tool?: string;          // 相关工具名
  detail: Record<string, unknown>; // 操作详情
  success: boolean;       // 是否成功
  error?: string;         // 错误信息
  sessionId?: string;     // 会话标识（预留）
}
```

### 操作类型

| action | 触发场景 |
|---|---|
| `command.execute` | execute_command / batch_execute / watch_command 执行 |
| `file.write` | write_file 写入 |
| `file.delete` | delete_path 删除 |
| `file.move` | copy_move 移动/复制 |
| `session.set_cwd` | session_state set_cwd |
| `session.set_env` | session_state set_env |
| `session.reset` | session_state reset |
| `safety.block` | 危险命令/路径被拦截 |
| `cache.invalidate` | cache_invalidate |

### 实现

新增 `src/audit.ts`：

- `audit.record(entry)`：追加写入 `audit.jsonl`
- `audit.recent(n)`：读取最近 N 条
- 内部按 `MCP_AUDIT_MAX_ENTRIES` 轮转，默认 10000 条
- 写入失败时使用 `logger.warn`，不抛异常影响主流程

### 埋点位置

- `src/tools/command.ts`：命令执行前后
- `src/tools/files.ts` / `manage.ts`：写/删/移动
- `src/tools/utility.ts`：session_state、cache_invalidate
- `src/security.ts` / `safeguard.ts`：拦截处

### MCP Resource

新增 `audit://log` 资源：

- URI: `audit://log?limit=50`
- 返回最近 N 条审计记录 JSON 数组

### 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_AUDIT_MODE` | `errors` | 审计模式：`off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | 最大保留条目数 |

## 接口不变

所有工具输入输出 schema 不变，仅在内部追加审计记录。

## 测试

- `tests/audit.test.ts`：写入、读取、轮转
- 更新 `e2e-latency.test.ts`：验证 health 资源包含 audit 字段

## 验收标准

- [ ] 命令执行后 audit.jsonl 增加记录
- [ ] `audit://log` 资源可读取
- [ ] 超过最大条目数时自动轮转
- [ ] build / lint / test / latency 全绿
