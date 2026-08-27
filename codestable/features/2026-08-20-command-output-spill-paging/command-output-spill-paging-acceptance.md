---
doc_type: feature-acceptance
feature: 2026-08-20-command-output-spill-paging
status: done
summary: 对照 design 逐节核对 M2 A+ 输出捕获/溢写/分页/secret/容量/envelope 实现，回写 roadmap 状态并记录归 M4 的架构差异清单
tags: [command-output, paging, envelope, temp-manager, secret-scan, encoding, acceptance]
created: "2026-08-21"
---

# command-output-spill-paging 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-21
> 关联方案 doc：`command-output-spill-paging-design.md`

## 1. 接口契约核对

对照方案第 2.1 节名词层逐一核查。

**接口示例逐项核对**：

- [x] `BatchCommandResult` union：`src/result.ts:92-94` 定义 `{ index; command; status: "completed" } & CommandOutputEnvelope & { latency_ms }` 与 `{ index; command; status: "skipped"; skip_reason: "stop_on_error" }` 两分支，与 design 2.1 示例一致。
- [x] `CommandOutputEnvelope`：`src/result.ts:63-90` 定义全部字节字段、encoding、cache/page 字段、`cache_disabled_reason`、`capture_limit_reached`、`error`，与 roadmap 4.6 一致。
- [x] `CacheDisabledReason`：`src/result.ts:61` 三值 `secret_detected | temp_capacity_exceeded | temp_unavailable`，一致。
- [x] `commandOutputSchema` / `completedBatchSchema` / `skippedBatchSchema`：`src/result.ts:272-315`，`completedBatchSchema` 复用 `commandOutputSchema.shape` 并补 `index/command/status/latency_ms`，`skippedBatchSchema` 只含 `index/command/status/skip_reason`，与 design 一致。
- [x] `SECRET_DETECTED` 错误码：`src/result.ts:36` 加入 `ErrorCode`，一致。

**名词层"现状 → 变化"逐项核对**：

- [x] 新增 `src/capture.ts`（child lifecycle / 原始字节 / backpressure / drain / actual 计数）：已落地，且实现阶段额外补齐每流 chunk 顺序保证（全量测试暴露的异步重排问题）。
- [x] 新增 `src/command-output.ts`（共享 A+ workflow）：已落地，含 limits 校验、scanner gate、retention、fallback、finalize、envelope 组装。
- [x] 共享 secret pattern registry：`src/secret-registry.ts` + `src/secret-stream.ts`，whole-string `scanContent` 与流式 matcher 同源。
- [x] `src/paging.ts` 重写为 page cache v2 四文件：已落地。
- [x] `src/temp-manager.ts` 扩展 reservation/lease/stats：已落地。
- [x] `src/result.ts` 新增 envelope 类型与 schema：已落地。
- [x] `src/tools/command.ts` 三 handler 复用编排层：已落地。
- [x] 乱码触点：design 原文写 `src/shell.ts`，实现证据表明根因是输出原始字节编码判定，实际修复在 `src/command-output.ts` 的 `detectOutputEncoding`。**已回填 design doc（第 1.3/2.1/2.3/2.4 节）**，`shell.ts` 选择与 invocation 未变。

**流程图核对**（第 2.2 节 mermaid）：图中 capture → scanner gate → retention/溢写 → finalize → envelope 各节点均有代码落点；`execute_command({cache_id})` 独立只读支线落在 `pageCache.read`，不重跑命令。

## 2. 行为与决策核对

对照方案第 1 节 + 第 2.2 节。

**需求摘要逐项验证**：

- [x] 行为 B1（超限不杀进程，drain 计数，成功可 ok:true+truncated:true）：`src/command-output.ts` `retainChunk` 上限后停止保留但仍 drain，`captureCommand` 不因输出量杀进程。
- [x] 行为 B2（≤1MiB 不落盘，仅超内存阈值溢写）：`runCommandOutput` 内存模式不创建 temp/cache_id。
- [x] 行为 B3（四个输出环境变量进程级校验，无效 VALIDATION_ERROR）：`getCommandOutputLimits` 返回 error，`command.ts` 三 handler spawn 前转 VALIDATION_ERROR。
- [x] 行为 B4（cache_id v2 + meta 白名单）：`paging.ts` `CACHE_ID_PATTERN` 与 `parseMeta` 白名单字段。
- [x] 行为 B5（execute 严格二选一）：`command.ts:268` `hasCommand === hasCache` 与 cache 模式拒绝 command/cwd/timeout。
- [x] 行为 B6（watch duration 是窗口非 timeout）：`timeoutMode: "watch_window"`，`capture_limit_reached=true`、`timed_out=false`。
- [x] 行为 B7（batch 并发 1/4 work queue + skipped union）：`command.ts:550` 动态 work queue，未调度项 `status: skipped`。
- [x] 行为 B8（stderr 仅 page 1，原失败命令读取 isError:false）：`paging.ts` `read` 的 `page === 1` 分支 + `buildCachedEnvelope` 保留原 error。
- [x] 行为 B9（scan-before-persist + 8192-byte quarantine）：`command-output.ts` `scan` 在 `writeAccepted` 前，`secret-stream.ts` 固定 8192。

**明确不做逐项核对**（反向核对项）：

- [x] 不新增第 27 个以外的工具（e2e `tools/list` 报告 27 个工具）。
- [x] 不新增独立 stderr 分页工具。
- [x] 不把命令工具改成后台 job API。
- [x] 不改变命令 policy / SafeGuard / shell 选择优先级（`shell.ts` 未改）。
- [x] Unix/macOS 仍 `/bin/sh -c`。
- [x] 不引入 argv-only 执行模型或 OS sandbox。
- [x] 不迁移旧格式分页缓存（旧 `stdout.txt` 目录保留，TTL 自然消亡）。
- [x] 不激活 ProcessPool。

**关键决策落地**：

- [x] 决策「捕获与编排边界」：`capture.ts` 不感知 page/cache/envelope，`command-output.ts` 组合。
- [x] 决策「分页存储」：`paging.ts` 原始字节 + 1024 code point 检查点 + 范围读取。
- [x] 决策「资源治理」：`temp-manager.ts` 懒创建 + reservation + 跨进程短锁 + heartbeat lease + TTL/LRU。
- [x] 决策「secret 扫描」：共享 registry + 原始字节状态机 + 8192 quarantine + writer 前 fail-closed。
- [x] 决策「envelope 收敛」：`result.ts` 定义，`command-output.ts` 组装，三 handler 只做入口。
- [x] 决策「原失败命令翻页」：cache read `isError:false`、envelope 保留原 error。
- [x] 决策「乱码修复」：实际落在 `command-output.ts` 原始字节编码判定（design 已回填，见第 1 节）。

**编排层"现状 → 变化"逐项核对**：三 handler 保留各自 policy/rate limit/SafeGuard/shell 差异，统一把 invocation 交给 `runCommandOutput`；分页读取走 `pageCache.read` 独立只读支线，不经过 policy/SafeGuard/rate limit。

**跨层纪律核对**：

- [x] 错误语义：参数互斥/越界页 VALIDATION_ERROR、非法 cache_id PATH_NOT_FOUND、损坏 EXECUTION_FAILED+cache_corrupt、锁超时 cache_lock_timeout、strict 命中 SECRET_DETECTED。
- [x] 降级与计数：secret > temp 容量/锁/writer；`retained_*_bytes` 只计最终实际返回/缓存字节。
- [x] 幂等性：分页读取不重跑；只有成功读取刷新 TTL；rename 成功前不暴露 cache_id。
- [x] 并发/顺序：batch work queue 并发 1/4；TempManager mutex + 跨进程短锁。
- [x] watch 终止：duration 是 watch_window 非 timeout；terminationFailed 返回 detail=watch_termination_failed。
- [x] 分页响应：page 1 带 stderr，page>1 空 stderr 但统计完整。
- [x] 可观测点：`command.execute` + 新增 `command.output.read`（只记 cache_id/页码/读取量）。
- [x] 安全性：cache_id 四重校验；scanner 保守超集；meta/audit 不含 secret 原文/command/cwd。

**挂载点反向核对**（对照第 2.3 节，grep 已执行）：

- [x] 挂载点 M1（三工具公开 schema）：`src/tools/command.ts` `commandOutputSchema` + `completedBatchSchema`/`skippedBatchSchema`。
- [x] 挂载点 M2（输出治理配置入口）：`src/command-output.ts` 四个 env + `src/scan.ts` `getSecretsScanTier` 扩展。
- [x] 挂载点 M3（状态目录协议）：`src/paging.ts` 四文件 + cache_id v2 + staging。
- [x] 挂载点 M4（统一错误协议）：`src/result.ts` `SECRET_DETECTED` + envelope schema。
- [x] 挂载点 M5（audit 协议）：`src/tools/command.ts` `recordOutputRead` → `command.output.read`。
- [x] **反向核查**：grep 全 src 的 `SECRET_DETECTED`/`CommandOutputEnvelope`/`BatchCommandResult`/`commandOutputSchema`/`completedBatchSchema`/`skippedBatchSchema`/`command.output.read` 全部命中均在清单内，无漏记挂载点。
- [x] **拔除沙盘推演**：按清单逆向移除 `result.ts` 的类型/schema、`command.ts` 的 schema 引用、`paging.ts` 的四文件、`temp-manager.ts` 的 staging/finalize、`scan.ts` 的 tier 扩展、`command-output.ts` 的 env 解析后，公开能力消失且无残留。

## 3. 验收场景核对

对照方案第 3 节关键场景清单，逐条可观察证据验证（证据来源：全量 `npm test -- --run` 39 文件/532 用例全绿 + `npm run test:latency` 24 项全绿）。

- [x] **S1 非 secret 小输出不落盘全量返回**：`tests/unit/tools/command.test.ts`「returns over-2000-character output in memory without creating a cache」验证 4000 字符不落盘、`paged=false`、无 cache_id。结果：通过。
- [x] **S2 安全中等输出完整分页**：`tests/unit/tools/command.test.ts`「spills only after the memory threshold...」验证 1.2MiB 输出 total_pages=600、page 2 读取无重跑；e2e「paged output can be read by cache_id without rerun」验证 cache 读取不重跑。结果：通过。
- [x] **S3 batch 队列/跳过/计数**：`tests/unit/tools/command.test.ts`「batch reports skipped commands and stable counters」验证 completed/skipped/failed/all_ok 不变量。结果：通过。
- [x] **S4 watch 窗口结束**：`tests/unit/tools/command.test.ts`「watch duration is a normal capture window, not a timeout」验证 `timed_out=false`、`capture_limit_reached=true`。结果：通过。
- [x] **S5 乱码修复三链路一致**：`tests/unit/tools/command.test.ts`「decodes Chinese output consistently across cmd, powershell, and pwsh」验证三 shell `echo 中文测试` 一致。结果：通过。
- [x] **S6 超限不杀进程 + truncated 分流**：`capture.test.ts`/`command-output.test.ts` 覆盖超限 drain、actual 计数、truncated 标记。结果：通过。
- [x] **S7 编码矩阵**：`paging.test.ts` 覆盖 BOM/GBK/非法 UTF-8/emoji/CRLF/pageSize 重算。结果：通过。
- [x] **S8 参数互斥与 cache read 语义**：`command.test.ts`「requires exactly one execution or cache mode」+「reads a failed command cache...」验证互斥与 isError 差异。结果：通过。
- [x] **S9 cache 四重校验与损坏处理**：`paging.test.ts` 覆盖非法 ID/损坏索引/路径穿越/junction。结果：通过。
- [x] **S10 资源降级与 TTL/LRU/崩溃恢复**：`temp-manager.test.ts` 31 用例覆盖 reservation/锁/lease/恢复/清理矩阵。结果：通过。
- [x] **S11 secret 四 tier 全矩阵**：`secret-stream.test.ts`/`secret-registry.test.ts`/`scan-tiers.test.ts` 覆盖差分、任意 chunk、8191/8192/8193、EOF。结果：通过。
- [x] **S12 错误/降级 envelope 统计口径**：`command.test.ts` strict secret + 原失败命令读取 + `command-output.test.ts` 降级预览。结果：通过。

**前端改动**：本项目无前端 UI，无浏览器验证项。

## 4. 术语一致性

对照方案第 0 节 + 第 2.1 节命名 grep 代码：

- [x] `A+ 捕获` / `内存模式` / `溢写模式`：`command-output.ts` 命名一致。
- [x] `quarantine`（8192 bytes）：`secret-stream.ts` 固定常量，无环境变量泄漏。
- [x] `page cache v2` / `cache_id v2`（`page-cache-<13位毫秒>-<32位hex>`）：`paging.ts` `CACHE_ID_PATTERN` 一致。
- [x] `envelope` / `retained` / `actual` / `total_chars`：`result.ts` 与 `command-output.ts` 命名一致。
- [x] `fallback preview`（65536 bytes）：`secret-stream.ts` `COMMAND_OUTPUT_FALLBACK_PREVIEW_BYTES` 一致。
- [x] 防冲突：禁用词（`stdout.txt` 作为生产新布局、`Math.random()` 生成 cache_id）grep 无命中（新代码用 `randomBytes`）。

## 5. 架构归并

按方案第 4 节：本 feature **不回写** `ARCHITECTURE.md` / `requirements/` / decision——文档同步统一归 M4（`post-merge-doc-sync-and-acceptance`）。本节记录差异清单作为 M4 输入。

**归 M4 的差异清单**：

1. `ARCHITECTURE.md` ADR-17（M2 过渡态）需更新为最终 A+ 契约：删除"staging writer、page cache v2、SECRET_DETECTED、batch/watch/cache read A+ envelope 和阶段 C 门禁尚未完成"的过渡表述，改为已完成事实；ADR-8（流式执行）同步确认三工具已切换到 capture.ts。
2. `ARCHITECTURE.md` 术语表「CommandOutputRuntime」「Page Cache」需从"尚未接通/legacy 文本分页"更新为 A+ 已落地。
3. `ARCHITECTURE.md` 状态目录结构节：`temp/` 下的 `page-cache-*` 布局从 legacy `.meta.json/stdout.txt/stderr.txt/meta.json` 更新为 `stdout.bin/stderr.bin/stdout.idx/meta.json`。
4. `ARCHITECTURE.md` 资源上限节：四个输出环境变量从"M2 当前共享捕获还进程级校验"更新为已落地事实。
5. decision `paging-cache-on-demand` 需 supersede（B2 已取代"超 pageSize 即落盘"）；decision `temp-manager-reuse` 需更新（懒创建/容量/reservation 已落地）。
6. requirements backfill：command output 能力无对应 req，由 M4 评估是否新建（本 feature frontmatter `requirement: null`）。

## 6. requirement 回写

方案 frontmatter `requirement: null`，且方案第 4 节明确 requirements backfill 归 M4 评估。本 feature 不落档 requirements，差异清单已列入第 5 节第 6 项，由 M4 执行。

## 7. roadmap 回写

方案 frontmatter `roadmap: merge-e-hardening-into-d` + `roadmap_item: command-output-spill-paging`，已实际回写：

- [x] `codestable/roadmap/2026-08-19-merge-e-hardening-into-d/merge-e-hardening-into-d-items.yaml`：`command-output-spill-paging` 条目 `status: in-progress` → `done`，notes 更新为验收通过事实；yaml 校验通过。
- [x] `codestable/roadmap/2026-08-19-merge-e-hardening-into-d/merge-e-hardening-into-d-roadmap.md` 第 5.2 节：状态改为 `done（2026-08-21 验收通过）`，三段进度合并为「已完成」清单；第 10 节变更日志追加 M2 验收记录。

## 8. AGENTS.md / CLAUDE.md 候选盘点

- [x] 候选 1：**e2e/latency/safeguard 测试加载的是 `build/index.js`（编译产物），不是 `src/`**——改源码后必须先 `npm run build` 再跑 e2e，否则子进程仍用旧代码。本次 M2 验收期间就因未先 build 导致 watch 回归测试一度误报。建议补入 AGENTS.md「已知坑」。
- [x] 候选 2：Windows 下 `TEMP/TMP/TMPDIR` 需显式指向非 C 盘（`E:/Codex_Temp`）后 `os.tmpdir()` 才解析到 E 盘——本次已遵循 C 盘写入限制，可作为跨 feature 通用环境约定（AGENTS.md 已有 C 盘限制专章，可考虑补充测试临时目录的具名示例）。

本节只登记，不擅自写入；是否落盘由用户定。

## 9. 遗留

- 后续优化点：
  - `src/tools/command.ts` 三 handler 的 precheck / rate limit / audit / shell 解析样板高度重复，envelope 落地后可另走 `cs-refactor` 评估（design 2.5 已列，本 feature 未搬）。
  - `utils.safeExec` / `quickExec` 仍消费旧 `spawnStream` 字符串语义，是否迁移字节级解码可另行评估（design 2.5 已列，本 feature 未迁移）。
- 已知限制：
  - `tests/unit/utils.extended.test.ts` 的 `vi.unmock("../../src/shell.js")` 不在模块顶层，Vitest 已告警（未来版本会变 error）——既存问题，非本 feature 引入，未扩大范围修改。
  - checklist 的 S5 `action` 原文仍是"shell.ts 先定位根因再定点修复"（implement 阶段生成的历史文字，acceptance 不改 steps）；design 已回填为 command-output.ts，后续如要消除文字偏差需在 design/checklist 重生成时处理。
- 实现阶段"顺手发现"：
  - 异步 `onChunk` 处理可能导致同一 stdout 流 chunk 并发处理、大输出 staging 交错——已在 `capture.ts` 补齐每流串行队列（真实 bug，非测试夹具问题）。
  - 乱码根因确认为 cmd 管道原始字节 GBK、pwsh/powershell UTF-8，修复落在输出解码层而非 shell invocation。
