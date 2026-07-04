---
name: state-persistence-and-upgrades
created: 2026-07-05
status: active
---

# Enhanced Terminal MCP 综合升级 Roadmap

## 背景

项目已完成基础清理（Biome lint 修复、常量集中、utility 抽出、shell 统一）。下一阶段围绕**状态持久化落地、可观测性增强、资源自动回收、架构对齐 Auto Code MCP** 展开。

## 阶段规划

### Phase 1: 状态目录迁移（当前激活）

**目标**：把会话状态文件从系统临时目录迁移到项目工作目录下的 `.enhanced-terminal-mcp/session.json`。

**关键交付**：
- `src/state-dir.ts`：状态目录解析、创建、环境变量覆盖
- 更新 `src/session.ts`：使用新路径、原子写入、旧文件迁移
- 更新 `.gitignore`：忽略 `.enhanced-terminal-mcp/`
- 新增 `tests/state-dir.test.ts`

**验收**：状态文件生成在项目目录下；旧文件可迁移；build/lint/test/latency 全绿。

---

### Phase 2: 审计日志

**目标**：建立结构化审计日志，记录命令执行、文件写删、会话变更、安全拦截。

**关键交付**：
- `src/audit.ts`：审计日志写入、读取、轮转
- 写入 `.enhanced-terminal-mcp/logs/audit.jsonl`
- `audit://log` 资源暴露最近 N 条记录
- 命令执行、文件操作、安全拦截处埋点

**验收**：审计文件正确生成；`audit://log` 资源可读取；不破坏现有工具接口。

---

### Phase 3: 临时资源管理

**目标**：建立 TTL + LRU 的临时资源回收机制，为未来大文件分页、编辑快照、归档中转做准备。

**关键交付**：
- `src/temp-manager.ts`：临时目录创建、访问刷新、TTL/LRU 清理
- 配置项：`MCP_TEMP_TTL_MS`、`MCP_MAX_TEMP_DIRS`、`MCP_TEMP_CLEANUP_INTERVAL_MS`
- 服务启动和退出时全量清理
- `temp_stats` 工具暴露状态

**验收**：临时目录超 TTL 自动删除；超数量上限按 LRU 淘汰；测试可验证。

---

### Phase 4: 命令输出分页

**目标**：解决大输出被截断的问题，支持多页读取。

**关键交付**：
- `src/paging.ts`：输出分页缓存、页码计算
- 更新 `execute_command`：支持 `page` / `pageSize` 参数
- 分页缓存写入 `temp/page-cache/`，TTL 自动清理

**验收**：大输出可分页返回；不指定分页时行为不变；缓存自动回收。

---

### Phase 5: 可观测性增强

**目标**：整合 telemetry、health、temp_stats、audit 信息，提升运维可见性。

**关键交付**：
- `telemetry_report` 增加 temp/audit 统计
- `health://status` 增加状态文件位置、temp 统计、审计状态
- 新增 `temp_stats` 工具

**验收**：latency 测试中工具数量正确；health 资源字段完整。

---

### Phase 6: 文档与收尾

**目标**：更新 README、架构文档、compound 沉淀。

**关键交付**：
- 更新 `README.md`：状态目录、环境变量、新工具说明
- 更新 `codestable/architecture/ARCHITECTURE.md`
- 用 `cs-learn` / `cs-trick` 沉淀关键决策和复用模式

**验收**：文档与代码一致；所有验证命令通过。

## 依赖关系

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
```

## 配置项汇总

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `MCP_STATE_DIR` | `<project-root>/.enhanced-terminal-mcp` | 状态目录 |
| `MCP_TEMP_TTL_MS` | `3600000` | 临时文件 TTL |
| `MCP_MAX_TEMP_DIRS` | `100` | 临时目录数量上限 |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | 清理轮询间隔 |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | 审计日志最大条目数 |
| `MCP_AUDIT_MODE` | `errors` | 审计模式：off / errors / all |
