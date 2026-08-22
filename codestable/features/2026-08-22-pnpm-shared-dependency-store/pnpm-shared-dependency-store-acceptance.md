---
doc_type: feature-acceptance
feature: 2026-08-22-pnpm-shared-dependency-store
status: done
summary: 对照 design 完成 npm→pnpm lockfile 迁移、共享 content store 隔离验证、pnpm pack 与 npm consumer 兼容验证及全量质量门禁
tags: [pnpm, lockfile, package-manager, supply-chain, acceptance]
created: "2026-08-23"
---

# pnpm-shared-dependency-store 验收报告

> 阶段：验收闭环
> 验收日期：2026-08-23（门禁与可复现项当日重跑；会话级重型验证引用 2026-08-22/23 实现期 S 步证据）
> 关联方案 doc：`pnpm-shared-dependency-store-design.md`

## 1. 接口契约核对

本 feature 是包管理工作流变更，无运行时 API；"接口"核对对象是 manifest/lockfile/发布物契约。

- [x] `package.json` 新增且仅新增 `"packageManager": "pnpm@11.21.0"`；name、version、type、main、bin、description 均未变化（`git diff HEAD -- package.json` 全量 diff 只有一行新增）。
- [x] `package-lock.json` 已删除，`pnpm-lock.yaml` 是唯一 active lockfile（git status：`D package-lock.json`、`?? pnpm-lock.yaml`）。
- [x] 仓库根无 `pnpm-workspace.yaml`、无 `workspace:*` 依赖、无父 workspace 注册（`ls pnpm-workspace.yaml` → 不存在；manifest diff 无 workspace 字段）。
- [x] `scripts` 语义保持 npm consumer 兼容：`postinstall: node scripts/apply-mcp-sdk-patch.mjs`（零依赖）未变，发布物 `files` 清单未因包管理器变化而改动。
- [x] `pnpm-lock.yaml` 由原 `package-lock.json` 经 `pnpm import` 生成（S2），`@modelcontextprotocol/sdk` 仍精确锁定 1.29.0 + overrides，无未授权升级（S2/S4 checks passed）。

## 2. 行为与决策核对

**决策落地**：

- [x] 机器共享 store 是配置不是契约：`pnpm store path` → `E:\pnpm\v11`（非 C 盘）；`package.json`、`pnpm-lock.yaml`、`src/**`、发布物均不含该机器路径（2026-08-23 grep 复核，唯一提及在 README.md:175 / AGENTS.md:86 的刻意说明段落，且明确标注 "configuration, not part of the repository contract"）。
- [x] 项目运行时隔离：`node -e "require.resolve('@modelcontextprotocol/sdk/package.json')"` 解析到本项目 `node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_.../`（项目自有 virtual store）；`NODE_PATH` unset。
- [x] 维护者工作流切换到 pnpm 表达：README Development 节、AGENTS.md 常用命令均为 `pnpm run build` / `pnpm test` 等；Quick Start 保留 npm consumer 安装路径。
- [x] 不删除共享 store：迁移只管理项目内 `node_modules` 与临时 consumer/cache fixture（S5 清理记录于 checklist）。

**明确不做逐项核对**：

- [x] 未引入跨 MCP 仓库 workspace 聚合（无 pnpm-workspace.yaml）。
- [x] 未共享运行时 `node_modules` 或使用 `NODE_PATH`（解析证据见上）。
- [x] 未改动运行时源码以适配包管理器（本 feature 对 `src/**` 的改动为零；工作树上 src 改动全部属于 harness-headless-safety feature）。

## 3. 验收场景核对

对照 design 第 3 节 14 条 Acceptance Contract。证据分两类：**[R]** 2026-08-23 验收期重跑；**[S]** 实现期（2026-08-22/23）S 步执行并记录于 checklist（checks 全 passed）。

- [x] **A1** 干净 checkout + `pnpm install --frozen-lockfile` 成功、无第二 lockfile 产生。[R] 实测 `Already up to date, Done in 357ms`；lockfile 状态见第 1 节。
- [x] **A2** store 解析到非 C 盘。[R] `pnpm store path` → `E:\pnpm\v11`。
- [x] **A3** Enhanced 与独立临时 consumer 共用 content store，但 lockfile/virtual store/node_modules 各自独立。[S] S3（重叠依赖双项目安装对比）。
- [x] **A4** 删除项目 `node_modules` 后离线/frozen 复装复用已有 content，不联网下载。[S] S5。
- [x] **A5** 临时 consumer 请求不同版本时共享 store 双版本共存，Enhanced 仍解析 lockfile 内版本。[S] S3。
- [x] **A6** 运行时依赖解析属于本项目入口，不用 `NODE_PATH`、别的项目 `node_modules` 或手写链接。[R] `require.resolve` 落在项目 `.pnpm` virtual store；`NODE_PATH` unset。
- [x] **A7** 无跨仓库 workspace 元数据。[R] `pnpm-workspace.yaml` 不存在。
- [x] **A8** 五项门禁全绿。[R] `pnpm run build`（clean-build + tsc）、`pnpm exec tsc --noEmit`、`pnpm run lint`（biome 82 files clean）、`pnpm test`（42 文件 / 558 用例全过）、`pnpm run test:latency`（24/24 达标）；TEMP/TMP/TMPDIR 显式指向 `.etmcp/test-tmp`，未落 C 盘。
- [x] **A9** `pnpm pack --dry-run` 产物含公开入口与发布文件，不含 lockfile、virtual store、临时数据、机器 store 路径。[R] tarball 清单 grep `lock|node_modules|.etmcp|pnpm-store|E:\pnpm` 零命中（唯一 grep 命中为 "package:" 行首误匹配，已人工核对）。
- [x] **A10** clean npm consumer 以重定向 cache/temp 安装 tarball：postinstall 补丁生效、`build/index.js` 可脱离 checkout 启动。[S] S5（npm cache 指向 `.etmcp/npm-cache`，非 C 盘）。
- [x] **A11** 迁移前后 manifest 逐项比对：除显式 `packageManager` 元数据外全部不变。[R] `git diff HEAD -- package.json` 仅一行新增。
- [x] **A12** 重复 install/build/test/pack 幂等，无重复 lockfile 或失控 cache。[R] 验收期二次 frozen install no-op；五项门禁在实现期与验收期两轮通过。
- [x] **A13** 故意离线安装时依赖不可得 → pnpm 明确失败，不静默回退 npm 或 C 盘临时目录。[S] S5。
- [x] **A14** store 配置缺失/不可用 → 受控安装路径报错停止，不在 C 盘静默新建 store。[S] S5。

**Explicitly rejected outcomes 核对**（全部未发生）：无共享 `node_modules`；不依赖其他 MCP checkout 启动；`package-lock.json` 未作为第二 active lockfile 保留；机器路径未进入 manifest/lockfile/源码/发布物；npm consumer 无需安装 pnpm 或了解本地布局；验收不仅凭 `pnpm install`，build/lint/test/latency/pack/consumer 证据齐备。

本项目无前端 UI，无浏览器验证项。

## 4. 术语一致性

- [x] `packageManager pin`、`shared content store`、`virtual store`、`frozen-lockfile` 在 README、AGENTS.md、design 与本文档语义一致。
- [x] "store 路径是机器配置不是仓库契约" 的口径在 README.md:175 与 AGENTS.md:86 一致，且与实现（无硬编码路径）相符。
- [x] pnpm 维护者工作流与 npm consumer 安装路径在 README Development 节与 Quick Start 节分别陈述、互不混淆。

## 5. 架构归并

- [x] `codestable/architecture/ARCHITECTURE.md` §1 已记载 pnpm 11.21.0 + `pnpm-lock.yaml`、多 MCP 复用机器 content store 但各自保留 virtual store/`node_modules` 的约束。
- [x] `AGENTS.md` 项目信息节与已知坑已同步 pnpm 口径（store path 不得写入实现文件/lockfile/发布物；Windows 临时数据不落 C 盘）。
- [x] `CHANGELOG.md` Unreleased 已记录 pnpm 迁移相关条目（lockfile 转换、postinstall 零依赖补丁为 devDependency 策略）。

## 6. requirement 回写

- [x] 不适用：本 feature 是维护者依赖管理工作流变更，对 MCP 客户端用户无可感知行为变化，按 shared-conventions 不做 requirement backfill；用户侧安装兼容性由 README Quick Start 与 A10 证据覆盖。
