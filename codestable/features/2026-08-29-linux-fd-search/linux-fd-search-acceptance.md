---
doc_type: acceptance
slug: linux-fd-search
feature: 2026-08-29-linux-fd-search
status: done
created: 2026-08-29
last_reviewed: 2026-08-30
tags: [linux-parity, search, fd, optional-engine]
related_architecture: [enhanced-terminal]
---

# Acceptance · linux-fd-search（Linux parity 差距清单第 6 项）

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-30（实现与门禁 2026-08-29 起）
> 关联方案：`codestable/features/2026-08-29-linux-fd-search/linux-fd-search-design.md`
> 验收口径：Linux VPS（Node v26.7.0、fd 10.4.2）本地证据；Windows 侧不退化由"fd 段仅在 `!IS_WIN` 进入 + 全量回归 + Windows CI 重跑"保证，Windows runner 的实际执行由 CI 产生。

## 1. 接口契约核对（对照 design §3/§4）

| 设计契约 | 代码落点 | 结果 |
|---|---|---|
| `FD_PATH_ENV="ENHANCED_TERMINAL_FD_PATH"`；显式 fail-closed（isAbsolute → lstat 普通文件 → `--version` 探测），reason 四值 | `src/fd-resolver.ts:11,98-116` | 一致。四 reason 各有注入单测钉死 |
| PATH `fd` → `fdfind` → unavailable(`fd_not_on_path`)，探测失败记 attempted 后继续 | `src/fd-resolver.ts:120-131` | 一致。"探测失败继续下一候选"用例通过 |
| 进程级缓存（成败皆缓存）+ `resetFdResolverCache()` | `src/fd-resolver.ts:134-157` | 一致。并发共享同一 promise 用例通过（`Promise.all` 单探测） |
| 诊断不含 PATH 原值、`download_performed:false`、运行期不下载/不建状态目录 | `src/fd-resolver.ts:22-30,77-88`；模块只 import fs/path/logger/stream | 一致。默认 which 仅 `access(X_OK)` 不 spawn |
| resolver 平台中立不引入 IS_WIN | `src/fd-resolver.ts` 全文无 `platform.js` import | 一致。其单测在全平台运行，Windows 主 coverage 不失守 |
| `WARNING_CODES` 追加 `FD_EXEC_FAILED`/`FD_PARTIAL_ERRORS`，schema 不变 | `src/partial-result.ts:25-26` | 一致。`searchWarningSchema.code` 为开放 `z.string()` 未动 |
| `!IS_WIN` fd 段位于 IS_WIN 块之后、native 兜底之前 | `src/tools/search.ts:189-224` | 一致。Everything 路径逐字节未动（git diff 仅新增段与描述文本） |
| 显式配置错误 → `VALIDATION_ERROR`（param=env 名，不落兜底） | `src/tools/search.ts:36-44,193` | 一致。用例断言 `error.param === FD_PATH_ENV` 且 exec 零调用 |
| 隐式不可用 → debug 日志后静默 native 兜底 | `src/tools/search.ts:194` | 一致。用例断言无 FD warning 且命中 fixture |
| fd 参数：argv 数组 + `--` 终止，无 shell 拼接；显式 `max_depth` 才下发 `--max-depth` | `src/tools/search.ts:47-61` | 一致（一处实现修正见 §3）。args 逐字段断言 + 真实 fd 冒烟双保险 |
| stderr 非空行 → `complete=false` + `FD_PARTIAL_ERRORS(count)` | `src/tools/search.ts:211-216` | 一致。2 行 stderr → count=2 用例通过 |
| exec 失败（非 abort）→ `FD_EXEC_FAILED` + native 兜底；abort → `Errors.cancelled` | `src/tools/search.ts:217-222` | 一致。reject 后 native 命中真实 fixture；abort 用例断言 `CANCELLED` |
| `search_files` description / `max_depth` describe 微调，schema 形状不变 | `src/tools/search.ts:105-120` | 一致。工具数 27/26 与 outputSchema 字段不变（全量 conformance/surface 用例通过） |

## 2. 验收标准逐条（对照 design §8）

- **`pnpm run gate`（release）全绿**：11/11 阶段 passed（build/typecheck/lint/test/coverage-main/coverage-tools/latency/dependency-audit/package-verifier/pack-consumer/clean-consumer），报告 `.etmcp/gate-report.json` status=passed exit 0。✅
- **fd 存在时走 fd**：Linux 本机 fd 10.4.2 真实冒烟——resolver 解析 `source=path`、search_files 端到端命中嵌套 fixture（`inner/gamma.txt`），args 捕获断言逐字段正确。✅
- **fd 不存在时与现状一致**：隐式 unavailable 用例静默 native 兜底、无 warning、不触 exec。✅
- **显式 env 错误 fail-closed**：真实 resolver + 缺失路径 → `VALIDATION_ERROR`，`detail.reason=explicit_path_missing`，`download_performed:false`，exec 零调用。✅
- **工具数不变（27/26）、`tools/list` 契约不变**：全量 71 文件 841 用例 25 跳过 0 失败（含 mcp-conformance 的 surface 断言）。✅

## 3. 实现偏差记录（docs-first 修正）

- **`--absolute-paths` → `--absolute-path`**：设计稿参数列表写了复数形，fd 10.4.2 实测拒绝（exit 2，`a similar argument exists: '--absolute-path'`）。真实 fd 冒烟用例当场捕获；实现、测试、design §3.2 与 checklist 均已改为单数形。教训已沉淀进 STATUS.md §6（外部 CLI 参数必须真机冒烟钉死）。

## 4. 测试与门禁证据

- `tests/unit/fd-resolver.test.ts`：9/9 通过（解析链 7 + 缓存 1 + 真实环境冒烟 1）。
- `tests/unit/tools/search-fd.test.ts`：10/10 通过（buildFdArgs 2 + fd 段 8）；`vi.mock platform.js IS_WIN=false` 使 fd 分支在 Windows CI 同样执行，tools-coverage floor 不失守。
- 全量 `pnpm test`：71 文件 841 通过 / 25 跳过 / 0 失败（基线 822 → +19 新用例）。
- 主 coverage：lines 82.09 / branches 71.72 / functions 82.16 / statements 79.11（非 Windows 阈值 81/70/81/78 全过）；tools coverage lines 63.38（floor 55 达标）。
- release gate 11/11 passed（2026-08-29T16:00 UTC，`.etmcp/gate-report.json`）。

## 5. 反向审计结论

对照 design §3（解析链/接入段/常量）、§4（注入面/信任模型/输出契约/profile 面）、§8（验收标准）逐条核对一致，唯一偏差为 §3 记录的 flag 名修正（已回写设计稿）。已知语义差（dot 条目、结果序等）按 design §5 显式记录，不视为缺陷。文档回写（README env 表 + Linux Notes、ARCHITECTURE 模块表/术语表/平台段/变更日志、CHANGELOG [Unreleased]、STATUS.md、AGENTS.md 关键技术事实）与代码口径一致。
