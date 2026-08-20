---
doc_type: decision
category: tech-stack
date: 2026-07-12
slug: zod-v3-remain
status: active
area: dependencies
tags: [zod, mcp-sdk, dependencies, migration]
---

## 背景

依赖审计曾指出项目锁定 `zod@^3`，而 zod v4 已发布。`@modelcontextprotocol/sdk@1.29.0` 的 peer 声明为 `zod: ^3.25 \|\| ^4.0`，存在升级窗口。

## 决定

**短期内（直至 `deps-zod-v4-spike` 给出 go 并单独授权迁移）继续使用 zod v3（当前 ^3.25.x）。**
不在 hardening 主线上顺手升级 zod v4。

## 理由

- SDK 与现有全仓 `z.object` / 工具 inputSchema 在 v3 上稳定；v4 有破坏性变更，收益主要是长期维护而非安全紧急项。
- hardening 阶段优先安全与契约稳定性；混入大范围类型/校验迁移会放大回归面。
- 升级应有独立 spike：兼容矩阵、MCP SDK 实际路径、测试全绿、回滚方案。

## 考虑过的替代方案

- **立即升 v4**：未评估全仓 schema 与构建产物风险，否决。
- **锁死精确 3.x 禁止小版本**：无必要；保留 ^3.25 补丁窗口。

## 后果

- `package.json` 保持 `"zod": "^3.25.67"` 直至 spike go。
- 相关工作只能通过 roadmap item `deps-zod-v4-spike` 启动，不得夹带在无关 PR。
- spike 若 no-go，本 decision 保持 active；若 go 并完成迁移，应 supersede 本文件。

## 相关文档

- `codestable/roadmap/remaining-hardening/remaining-hardening-roadmap.md` § 子 feature `deps-zod-v4-spike`
- `package.json` dependencies
