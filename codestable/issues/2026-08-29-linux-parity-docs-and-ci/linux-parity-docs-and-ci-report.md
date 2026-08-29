---
doc_type: issue-report
issue: 2026-08-29-linux-parity-docs-and-ci
status: confirmed
severity: P3
tags: [docs, readme, ci, linux, cross-platform]
created: "2026-08-29"
---

# Linux 对等：README Linux 文档缺口 + CI 无 Linux 全量测试阶段

## 现象

1. **文档**：README 的 Quick Start / 环境说明全以 Windows 为中心（setup.bat、pwsh 解析链、Everything）；Linux 用户面临三个未文档化事实——归档工具依赖系统 `zip`/`unzip`（LINUX-VALIDATION-ISSUES.md P-08）、pwsh 链路无需配置、`everything_search` 不可用而 `search_files` 走原生兜底。
2. **CI**：`.github/workflows/ci.yml` 的完整门禁只在 windows-latest 跑（canonical-gate job）；ubuntu/macos 仅在 platform-smoke job 跑 build + 三个 e2e 套件，**全量单测与覆盖率门禁没有任何 Linux runner 覆盖**——16 条 Windows 耦合单测（issue `2026-08-29-linux-test-platform-guards`）长期未被发现即因此。

## 修复内容

- README 新增 "Linux Notes" 段（shell 差异、zip/unzip 系统依赖、Everything 不可用与原生兜底、其余平台中立）。
- ci.yml 新增 `unit-tests-linux` job（ubuntu-latest × Node 22）：build → `pnpm test` → `pnpm run test:coverage`（Linux floor，随 issue `2026-08-29-linux-gate-parity` 平台化后可过）→ `pnpm run test:coverage:tools`。

## 依赖与验收

- 依赖 `2026-08-29-linux-gate-parity` 先落地（否则 Linux 上 coverage 与延迟必挂）。
- 验收：README 段落准确反映代码行为；CI yaml 语法合法、job 步骤与本地已验证命令一致（本 VPS 已全绿）；Windows job 不动。
