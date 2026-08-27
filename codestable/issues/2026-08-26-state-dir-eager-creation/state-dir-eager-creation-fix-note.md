---
doc_type: issue-fix
issue: 2026-08-26-state-dir-eager-creation
status: resolved
severity: P2
resolution_date: "2026-08-26"
summary: getStateDir 拆为纯解析、新增 ensureStateDir（写路径专用）；session/audit/读路径全部收口为懒创建，启动零创建
tags: [state-dir, lazy-init, session, temp-manager, audit, paging]
created: "2026-08-26"
---

# server 启动即创建空 .etmcp 目录 — 修复记录

## 1. 修复内容

按 analysis §3.1 方案执行，核心是把"路径解析"与"确保目录存在"拆开：

| 文件 | 改动 |
|------|------|
| `src/state-dir.ts` | `getStateDir()` 改纯解析（resolve + 缓存路径，不 mkdir，签名不变）；新增 `ensureStateDir()`（mkdir recursive + 原 `Failed to create state directory` 错误语义），仅供写路径在真实产生物落盘前调用 |
| `src/session.ts` | `saveToDisk()` 写 session.json 前 `await ensureStateDir()`；恢复读取路径零改动即纯化 |
| `src/audit.ts` | `getLogFile()` 拆为 `resolveLogFilePath()`（纯解析，memo 路径）与 `ensureLogFilePath()`（mkdir logsDir）；`flush()` 走 ensure，`recent()` / `getLogFilePath()` 走纯解析 |
| `src/temp-manager.ts` / `src/paging.ts` | 零代码改动——`init()` 与 page cache 读取随 `getStateDir` 纯化自动零副作用；`ensureRoot()` 的 mkdir 保留（真实资源创建） |

## 2. 测试

- 改写 `tests/unit/state-dir.test.ts` 两条旧契约：`getStateDir` 解析不创建 + `ensureStateDir` 创建；mkdir 失败用例迁移到 `ensureStateDir`。
- 新增 `tests/unit/lazy-state-dir.test.ts`（5 用例）：session 恢复零创建 / session 持久化创建 / `tempManager.init()` 零创建 + `create()` 建 `temp/` / audit 读与展示零创建 / `record()+flush()` 建 `logs/audit.jsonl`。
- 新增 `tests/state-dir-lazy.test.ts`（e2e，报障场景等价回归）：干净 cwd 拉起 server → connect + 读 `audit://log` → 断言 `.etmcp` 不存在。
- 原验证曾发现 MCP ResourceTemplate 的字面模板 `audit://log` 不匹配 `audit://log?limit=5`（-32602），所以当时 e2e 只能读裸 URI；本次整理在 `src/index.ts` 同时注册固定 URI 与 `audit://log{?limit}` template，两个调用形式均有回归覆盖。

## 3. 验证结果（门禁全绿）

- `pnpm run build` ✓、`pnpm exec tsc --noEmit` ✓、`pnpm run lint` ✓（biome 自动修 2 处新测试文件格式/导入排序）
- `pnpm test`：44 文件 / 577 用例全过（基线 39/543 + 新增）
- `pnpm run test:latency`：24 用例全过，无阈值超标
- 实证复验（与报障同步骤）：干净目录启动 server 4 秒 → 关闭 → 项目目录**无 `.etmcp`**（修复前同步骤产生空 `.etmcp`）

## 4. 行为不变量（修复后口径）

启动 / session 恢复 / `audit://log` 与 `health://status` 读取 / `telemetry_report` / `temp_stats` → 零创建；首个 session 持久化建 `.etmcp` + `session.json`；首条 audit 写入建 `.etmcp/logs/audit.jsonl`；首个 temp/page-cache 资源建 `.etmcp/temp/...`；legacy 迁移仅在旧目录存在时写迁移产物。

## 5. 文档同步

- `ARCHITECTURE.md`：§3.2 state-dir 行补纯解析/ensure 语义；§4 改为懒创建口径；最后核对日期 2026-08-26。
- `README.md`：Features 新增 Lazy State Directory 条目。
- `AGENTS.md`：已知坑状态目录一行改为根目录懒创建口径。
