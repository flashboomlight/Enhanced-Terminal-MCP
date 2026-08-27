---
doc_type: refactor-apply-notes
refactor: 2026-08-28-structural-debt-cleanup
status: done
---

# structural-debt-cleanup apply notes

> 放行依据：用户 2026-08-28「照你说的办，最后我要你解决全部债务」整体授权，逐步 AI 自证（本项目无前端 UI，无 HUMAN 目视项）。

## 步骤 1: 裁剪 adaptive.ts DEFAULT_TIMEOUTS（R4）

- 完成时间: 2026-08-28
- 改动文件: src/adaptive.ts
- 验证结果: `vitest run tests/unit/infra.test.ts tests/unit/upgrades-r2.test.ts tests/unit/core.test.ts` → 3 files / 90 tests 全绿；`withRetry`（archive.ts 唯一消费方）不受影响
- 偏离: 无

## 步骤 2: scan.ts 弃用再导出迁移（R5）

- 完成时间: 2026-08-28
- 改动文件: src/scan.ts、tests/unit/core.test.ts
- 验证结果: core 单测绿；`grep -rn isCredentialFilePath src/ tests/` 零命中
- 偏离: 无

## 步骤 3: command.ts 前奏提取（R1）

- 完成时间: 2026-08-28
- 改动文件: src/tools/command.ts
- 验证结果: `pnpm run build` + tools/command 单测 9 用例 + e2e-latency 24 用例全绿
- 偏离: 无。三处 limits fail 的差异（batch 带 `param: "commands"`）以可选参数保留；watch 的 `commandError` subject 参数化进 `finishCommandEnvelope`；batch_execute 仅复用 limits helper（其 shellSpec 复用形态与单命令不同，保持现状）

## 步骤 4: temp-manager 拆分（R3）

- 完成时间: 2026-08-28
- 改动文件: 新增 src/temp-core.ts；src/temp-manager.ts 改为执行器 + facade
- 验证结果: tsc 零错误；biome 干净；temp-manager 单测 31 用例全绿
- 偏离: 无。re-export 采用显式符号清单（非 `export *`）；TEMP_LOCK_*/DISK_BYTES_CACHE_MS 仅 TempManager 使用，保留在 temp-manager.ts 未迁移

## 步骤 5: paging 拆分（R2）

- 完成时间: 2026-08-28
- 改动文件: 新增 src/paging/{codec,index-format,paths,errors}.ts；src/paging.ts 重写为编排 + facade
- 验证结果: tsc 零错误；biome 干净；paging 单测 10 用例全绿；后续全量门禁 47 文件 578 用例全绿
- 偏离（design 时未预见，均已记录）:
  1. **新增 `src/paging/errors.ts`**：PageCacheCorruptError/PageCacheReadError 需被 index-format/paths 引用，放 paging.ts 会造成循环 import，独立成错误模块
  2. **clampPageSize 留在 paging.ts**：它依赖 DEFAULT/MAX_PAGE_SIZE 契约值，放 paths.ts 会反向依赖
  3. 实施中发现并修复一处重写笔误（trimIncompleteTail 内 `first`→`lead`），tsc 立即暴露
  4. paths.ts 初版误用 `require("node:path")`，当即改为 ESM import

## 步骤 6: 收尾全量门禁

- 完成时间: 2026-08-28
- 验证结果: 见最终门禁记录——build / tsc / lint / vitest（47 文件 578 用例）/ e2e-latency（24）/ test:coverage:tools 全绿
- 偏离: 门禁集相较 design 新增 `test:coverage:tools`（同日新增的工具层覆盖门禁，属本次债务清理交付物）

## 同批处理（非 refactor，行为变更项，各自记录于 CHANGELOG）

- SDK postinstall 补丁 fail-closed 化 + tests/unit/sdk-patch.test.ts（4 用例：patched/幂等/fail-closed/未装跳过/失配警告）
- 四模块补盲单测 files/manage/system/archive（27 用例）+ 工具层覆盖门禁
- CI workflow + `pnpm run gate`
- README 补 `ENHANCED_TERMINAL_DISABLE_FILE_INFO`
- roadmap 目录日期前缀统一 + 空目录清理 + 过期交叉引用修正 + 全库路径引用更新
- 3 个既有测试文件的 `E:/Codex_Temp` 迁移至项目内 `.etmcp/test-tmp`

## 关键发现（实施中新暴露的债务/坑）

1. **cmd 链路无法携带带引号的空格路径**：`spawnStream` 用 Node 默认 argv 转义，内嵌 `"` 被 `\"` 化后 cmd 引号解析错乱（`/s` 更甚）。测试迁移到项目内路径（含空格）后立刻暴露。测试侧已用 `cwd: scriptDir` + basename 规避；修 spawnStream/shell 属执行核心改动，登记 AGENTS.md 已知坑，留待独立 issue
2. **工具层覆盖盲区已量化**：全局覆盖率 79.41% 的假安心感被打破——工具层真实 statements 60% / branches 50%。已用专属门禁设底
3. **测试串行执行核查结论（并发债，close as won't-fix）**：Vitest 默认跨文件并行、文件内串行；配置中的 `sequence.concurrent: false` 即默认值。文件内串行是承载性的——e2e 与工具单测在文件内共享模块单例（shell spec 缓存、session、safeguard 模式），文件内并发必然互相污染。真正的耗时在 e2e 子进程 spawn，属测试策略既定成本。结论：不改动，记录在案
4. `tests/unit/tools/utility.test.ts` 中 `formatCacheStatsMessage` 断言注释与实际调用的函数名不符（陈旧注释），无功能影响，未动（非本批范围）
