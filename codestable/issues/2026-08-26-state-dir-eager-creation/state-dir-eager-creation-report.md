---
doc_type: issue-report
issue: 2026-08-26-state-dir-eager-creation
status: resolved
severity: P2
resolution_date: "2026-08-26"
summary: harness 新开 session（server 启动、零工具调用）即在项目目录创建空的 .etmcp，违背"产生真实存储文件才创建目录"的设计要求
tags: [state-dir, lazy-init, session, temp-manager, audit]
created: "2026-08-26"
---

# server 启动即创建空 .etmcp 目录 Issue Report

## 1. 问题现象

在 harness（AI 客户端）中开启一个新 session，MCP server 进程刚启动、还没有调用任何工具时，项目文件夹里就出现了 `.etmcp` 目录。检查发现该目录是**空的**——没有 `session.json`、没有 `logs/audit.jsonl`、也没有 `temp/`，即 enhanced terminal MCP 此时没有产生任何真实存储文件，目录却被创建了。

用户的设计要求是：只有当 enhanced terminal MCP 真正产生相关存储文件（即 MCP 产生物）时才生成 `.etmcp` 文件夹并存放文件。

## 2. 复现步骤

1. 准备一个全新空目录 `proj/`（无 `.etmcp`、无旧版 `.enhanced-terminal-mcp`）。
2. 在 `proj/` 作为工作目录启动 server：`node <repo>/build/index.js`。
3. 等待 server 完成启动（约 4 秒），不做任何工具调用、不读任何资源。
4. 终止 server 进程。
5. 观察到：`proj/.etmcp` 已存在且为空目录。

复现频率：稳定（100%，Windows 实测；行为与平台无关，路径为进程 cwd 下的固定相对目录）。

补充观察：即使通过 MCP 客户端读取 `audit://log` 资源（纯读操作），也会进一步创建 `.etmcp/logs/` 目录，同样没有任何文件写入。

## 3. 期望 vs 实际

**期望行为**：server 启动、session 恢复读取、资源读取、遥测展示等不落盘任何东西的路径，绝不创建 `.etmcp`；目录只在第一个真实产生物（session 持久化、audit 条目写入、temp/page-cache 资源创建、legacy 迁移产物）实际写盘的那一刻才创建。

**实际行为**：仅启动 server 就创建了空的 `.etmcp`；读取 audit 资源还会创建空的 `.etmcp/logs/`。

## 4. 环境信息

- 涉及模块 / 功能：状态目录管理（`src/state-dir.ts`）、启动链路（`src/index.ts`）、session 恢复（`src/session.ts`）、临时资源管理器（`src/temp-manager.ts`）、审计日志（`src/audit.ts`）
- 相关文件 / 函数：待阶段 2 确认（初步线索：`getStateDir()` 首次调用的目录创建行为，以及启动期 `tempManager.init()` / `session.loadFromDisk()` / `audit.getLogFile()` 的调用链）
- 运行环境：Windows 10 开发机；harness 场景 = AI 客户端按 session 拉起 stdio server
- 其他上下文：README 承诺 "`temp` root 只在真正需要临时资源时创建"（`temp` 子目录本身确实懒创建成功）；ARCHITECTURE.md 记载 "`.etmcp` 根可由 session/audit 按需创建"。文档口径与用户要求之间也存在差距，需一并对齐

## 5. 严重程度

**P2** — 无功能损坏、无数据风险，但违背已明确的产品设计约束，且影响面是全部消费方（每个项目目录、每次 session 启动都会残留一个空目录），属于设计契约违约而非边界瑕疵。

## 备注

- 现有 `tests/unit/state-dir.test.ts` 第 29-40 行把"getStateDir 自动创建目录"当作预期行为断言——该断言来源于 2026-07-05 state-directory-migration feature 的旧设计口径，修复时需要同步改契约测试。
