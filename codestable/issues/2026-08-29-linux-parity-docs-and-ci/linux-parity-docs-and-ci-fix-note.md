---
doc_type: issue-fix
issue: 2026-08-29-linux-parity-docs-and-ci
status: done
created: "2026-08-29"
summary: README 新增 Linux Notes 段（shell/zip 依赖/搜索兜底/平台中立面），ci.yml 新增 unit-tests-linux job（ubuntu Node 22 跑全量测试 + 双覆盖率门禁）
tags: [docs, readme, ci, linux, fix]
---

# linux-parity-docs-and-ci 修复记录

## 改动

1. `README.md`：`Windows Default Shell` 节后新增 `## Linux Notes`——`/bin/sh -c` 执行、pwsh 链路 Windows-only、归档工具依赖系统 `zip`/`unzip`（附 apt 安装示例）、`everything_search` Windows-only + `search_files` 原生兜底（同一 partial-result 契约）、其余能力与环境变量平台中立。
2. `.github/workflows/ci.yml`：新增 `unit-tests-linux` job（ubuntu-latest × Node 22，复用既有 pinned action 版本）：install → build → `pnpm test` → `pnpm run test:coverage`（Linux floor）→ `pnpm run test:coverage:tools`。

## 验证

- 两个 job 的每条命令均已在本 Linux VPS 实测通过（全量 822 过 / 25 跳过；双覆盖率门禁通过；release gate 11/11，见 `2026-08-29-linux-gate-parity` fix-note）。
- ubuntu-latest runner 镜像预装 zip/unzip，归档 e2e 无额外依赖步骤。
- README 段落逐条对照代码行为核对（shell.ts unix 分支、platform.ts zip/curl spec、search.ts 原生兜底）。
- CI yaml 缩进/结构与既有 job 保持一致；未改动 Windows canonical-gate 与 platform-smoke 两个 job 的任何既有步骤。

## 边界

- CI 实际跑绿需合并后由 GitHub Actions 实证（本机无法模拟 runner）；若 runner 性能导致延迟断言抖动，后续按同一 issue 族处理（latency 在 canonical gate 已有 advisory 先例）。
