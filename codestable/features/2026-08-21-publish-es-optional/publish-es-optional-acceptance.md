---
doc_type: feature-acceptance
feature: 2026-08-21-publish-es-optional
status: done
summary: 对照 design 完成 Everything 本地可选解析、搜索契约、npm 发布裁剪和全量验收，并回写架构、requirement 与 roadmap
tags: [everything, es.exe, optional-runtime, supply-chain, npm-package, fallback, acceptance]
created: "2026-08-22"
---

# publish-es-optional 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-22
> 关联方案 doc：`publish-es-optional-design.md`

## 1. 接口契约核对

对照 design 第 2.1 节名词层和第 2.2 节流程图逐项核对。

**接口示例逐项核对**：

- [x] `ES_EXE_SHA256` / `ES_EXE_ENV`：`src/es-integrity.ts:13-14` 保持固定 hash 和环境变量名。
- [x] `EsExeResolution`：`src/es-integrity.ts:44-56` 区分 `available=true` 的 `explicit|state` 来源和带诊断的 unavailable 结果。
- [x] `EsExeDiagnostic`：`src/es-integrity.ts:29-42` 提供 `reason`、`expected_sha256`、`env_name`、`default_path`、`source`、`path` 和 `download_performed=false`。
- [x] `resolveEsExe()`：`src/es-integrity.ts:147-161` 按 explicit → state 顺序解析；没有候选时返回 state unavailable，不读取仓库 fixture。
- [x] 搜索错误映射：`src/tools/search.ts:27-51` 对 `search_files` 的显式坏配置返回 `VALIDATION_ERROR`，对 `everything_search` 保持 `EXECUTION_FAILED`，两者都携带 resolver 诊断。

**名词层“现状 → 变化”核对**：

- [x] 完整性解析由固定仓库路径改为显式环境变量或 state 目录候选：`src/es-integrity.ts:62-153`。
- [x] 成功结果按 fingerprint 缓存，文件变化后重新 hash：`src/es-integrity.ts:58-80`、`src/es-integrity.ts:120-142`。
- [x] `search_files` 和 `everything_search` 已接入新 resolver：`src/tools/search.ts:87-126`、`src/tools/search.ts:198-203`。
- [x] `package.json#files` 已移除 `es_tool/es.exe`，仓库 fixture 仍存在：`package.json:10-15`、`es_tool/es.exe`。

**流程图核对**：

- [x] Windows 判断、explicit/state 选择、lstat/fingerprint/hash、显式失败、native fallback、Everything 结构化失败和 `execFile` 均有实际代码落点。

## 2. 行为与决策核对

**需求摘要逐项验证**：

- [x] 固定 hash 的显式文件可以通过校验并执行：`tests/unit/es-integrity.test.ts:54-58`。
- [x] state 目录中的固定 hash 文件可以通过校验，生产路径不指向仓库 fixture：`tests/unit/es-integrity.test.ts:61-65`。
- [x] 显式配置错误不会回退到 state：`tests/unit/es-integrity.test.ts:68-79`、`tests/unit/tools/search.test.ts:106-127`。
- [x] 隐式 binary 不可用时普通搜索仍可用：`tests/unit/tools/search.test.ts:92-104`。
- [x] Everything 专用搜索在 binary 不可用时返回结构化安装信息：`tests/unit/tools/search.test.ts:129-147`。
- [x] 显式 Everything 配置错误仍遵守 `EXECUTION_FAILED` 契约：`tests/unit/tools/search.test.ts:149-169`。

**明确不做逐项核对**：

- [x] 不下载、不安装、不升级 Everything；resolver、search handler、package setup 中没有下载调用，最终静态核对通过。
- [x] 不读取仓库 `es_tool/es.exe` 作为生产默认路径；fixture 只由显式测试路径使用。
- [x] 不把 `everything_search` 扩展到非 Windows；handler 在 `resolveEsExe()` 前保留 Windows-only 判断。
- [x] 不改变现有搜索参数、工具数量、policy、SafeGuard 和 audit 语义；全量测试和 latency e2e 通过。

**关键决策落地**：

- [x] 显式配置 fail-closed：`src/es-integrity.ts:147-153` 只检查显式候选，不尝试 state；搜索层在 `src/tools/search.ts:97-100` 区分显式失败。
- [x] state 路径只表示本地可选依赖：`src/es-integrity.ts:67-68`，缺失不会创建 `tools` 目录。
- [x] fingerprint 失效：`tests/unit/es-integrity.test.ts:123-131` 验证文件内容变化后旧成功结果不再授权执行。
- [x] 并发首次解析共享 in-flight promise：`src/es-integrity.ts:149` 和 `tests/unit/es-integrity.test.ts:133-137`。
- [x] npm 发布裁剪：`package.json:10-15` 不再列出 fixture，`npm pack --dry-run` 不含 `es.exe`。

**跨层纪律核对**：

- [x] 错误语义按搜索入口区分：普通搜索显式配置错误是 `VALIDATION_ERROR`，Everything 专用入口是 `EXECUTION_FAILED`。
- [x] 可观测性保留 resolver `reason`、来源、默认路径和固定 hash，不写入 binary 内容或秘密原文。
- [x] 生产 resolver 不产生目录、不下载、不读取仓库 fixture。
- [x] 兼容导出 `ensureEsExeIntegrity()` 保留，旧消费者不会因 resolver 类型升级而失效：`src/es-integrity.ts:164-167`。

**挂载点反向核对**：

- [x] M1 完整性解析：`src/es-integrity.ts`。
- [x] M2 搜索入口：`src/tools/search.ts`。
- [x] M3 发布边界：`package.json#files`。
- [x] M4 验证边界：`tests/unit/es-integrity.test.ts`、`tests/unit/tools/search.test.ts`、`npm pack --dry-run`。
- [x] 反向 grep：`resolveEsExe` / `ensureEsExeIntegrity` / `ES_EXE_ENV` / `ES_EXE_PATH` 的生产和测试引用均落在上述清单内，没有发现额外生产挂载点。
- [x] 拔除沙盘：移除 resolver、两个搜索入口接入、package files 条目和对应测试后，M3 的可选解析、搜索差异和发布边界均消失；原有 native search 能力仍可独立保留。

## 3. 验收场景核对

证据来源为 resolver/search 专项测试、全量测试、latency e2e、build/lint/typecheck 和 package dry-run。

- [x] **S1**：显式路径指向固定 hash 普通文件 → 返回 `source=explicit` 并执行；`tests/unit/es-integrity.test.ts:54-58` 通过。
- [x] **S2**：显式路径不存在、目录或 hash 错误 → fail-closed，不尝试 state；`tests/unit/es-integrity.test.ts:68-79`、`:96-120` 通过。
- [x] **S3**：无显式配置且 state 文件有效 → 使用 state 路径；`tests/unit/es-integrity.test.ts:61-65` 通过。
- [x] **S4**：无显式配置且 state 文件缺失/非普通文件 → resolver 返回原因，且不创建 `tools` 目录；`tests/unit/es-integrity.test.ts:82-103` 通过。
- [x] **S5**：state binary 内容变化 → fingerprint 失效并重新 hash；`tests/unit/es-integrity.test.ts:123-131` 通过。
- [x] **S6**：并发首次解析 → 共享 in-flight 结果；`tests/unit/es-integrity.test.ts:133-137` 通过。
- [x] **S7**：隐式 Everything 不可用 → `search_files` native fallback；`tests/unit/tools/search.test.ts:92-104` 通过。
- [x] **S8**：显式 Everything 配置错误 → `search_files` 不 fallback，`everything_search` 返回 `EXECUTION_FAILED` 和诊断；`tests/unit/tools/search.test.ts:106-169` 通过。
- [x] **S9**：Everything binary 不可用 → detail 包含 `reason`、`expected_sha256`、`env_name`、`default_path`、`download_performed=false`；`tests/unit/tools/search.test.ts:129-169` 通过。
- [x] **S10**：无任何 resolver/search/package 下载调用；静态零下载核对通过。
- [x] **S11**：npm 发布包不含 `es.exe`，仓库 fixture 保留；`npm pack --dry-run` 和文件存在性检查通过。
- [x] **S12**：非 Windows 保持 Windows-only 语义；代码分支和测试契约保持不变。
- [x] **S13**：全量质量门禁：`npm run build`、`npx tsc --noEmit`、`npm run lint`、`npm test`（39 文件 / 543 tests）、`npm run test:latency`（24 tests）、`git diff --check` 全部通过。

本项目无前端 UI，无浏览器验证项。

## 4. 术语一致性

- [x] `explicit`、`state`、`unavailable`：代码、design、architecture 和 requirement 使用一致。
- [x] `fingerprint`、`fixed SHA-256`、`download_performed=false`：代码和公开诊断字段一致。
- [x] `native fallback`、`fail-closed`、`everything_search`：搜索入口、README、architecture 和 requirement 语义一致。
- [x] `es_tool/es.exe`：只表示开发/测试 fixture，不再表示生产默认路径或 npm 发布内容。

## 5. 架构归并

- [x] `codestable/architecture/ARCHITECTURE.md` 已更新搜索入口、resolver、外部 fixture、ADR-11 和 M3 当前状态。
- [x] 架构 frontmatter 的 `implements` 已回填 `everything-search-optional`，形成 architecture → requirement 关联。
- [x] 稳定的跨模块约束已写入架构：explicit/state/unavailable 顺序、显式 fail-closed、隐式 fallback、零下载和 npm 不含 binary。
- [x] `AGENTS.md`、`README.md`、`CHANGELOG.md` 已同步 M3 完成口径；M4 仍保留为整体发布文档复核阶段。

## 6. requirement 回写

- [x] 该 feature 增加了用户可感知的 Windows Everything 可选搜索边界，因此完成 requirement backfill：`codestable/requirements/everything-search-optional.md`。
- [x] requirement 已包含用户故事、痛点、当前解法和边界，未把实现函数或测试细节当作用户需求。
- [x] 方案 frontmatter 已回填 `requirement: everything-search-optional`。
- [x] requirement 和 architecture YAML 校验通过。

## 7. roadmap 回写

- [x] `codestable/roadmap/2026-08-19-merge-e-hardening-into-d/merge-e-hardening-into-d-items.yaml` 中 `publish-es-optional` 已从 `in-progress` 改为 `done`。
- [x] roadmap 主文档第 5.3 节已同步为 2026-08-22 验收通过。
- [x] roadmap 变更日志已记录 M3 验收、12 项 checks、全量门禁和测试稳定性修复。
- [x] items YAML 和 roadmap YAML 校验通过。

## 8. AGENTS.md / CLAUDE.md 候选盘点

- [x] 本 feature 未暴露需要新增到 `AGENTS.md` 的通用环境规则；非 C 盘临时目录和先 build 再跑 e2e 的规则已经存在。
- [x] 发现的 `vi.unmock()` 顶层 warning 已移到测试模块顶层；针对性测试和全量测试均无该 warning，不需要新增通用规则。

## 9. 遗留

- `build/` 旧测试产物和 `middleware.*` 已由 `scripts/clean-build.mjs` 在每次 build 前清理；最终 npm 包核对通过。
- `tests/unit/utils.extended.test.ts` 的 `vi.unmock()` warning 已修复，当前 543 个测试无 warning 通过。
- 为消除全量负载下的 TTL flaky，`tests/unit/temp-manager.test.ts:456-467` 增加了更充足的时间余量；未改变 TempManager 生产代码行为。
- 未执行 `git commit`，等待用户最终 review 和后续 scoped-commit 决定。
