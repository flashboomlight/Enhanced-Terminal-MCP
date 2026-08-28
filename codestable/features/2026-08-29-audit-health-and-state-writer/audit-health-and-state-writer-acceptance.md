---
doc_type: acceptance
slug: audit-health-and-state-writer
status: done
created: 2026-08-29
last_reviewed: 2026-08-29
tags: [production-hardening, audit, health, state, lock-fencing, temp-quota]
roadmap: 2026-08-28-production-hardening#8
related_architecture: [enhanced-terminal]
---

# Acceptance · audit-health-and-state-writer（production-hardening #8）

## 1. 交付映射

| 设计交付 | 落地 | 验证 |
|---|---|---|
| `src/lock-lease.ts`（owner/lease heartbeat/fencing/stale 接管） | 新模块 ~270 行；`TempManager.withTempLock` 内部换用（对外签名与 `TempLockTimeoutError` 语义不变），`state-dir` migration lock 换用 `withMigrationLock`（dead-owner 接管 + corrupt 锁 fail-closed） | `tests/unit/lock-lease.test.ts` 9 例 + 既有 temp/migration 60 例零回归 |
| audit serialized writer | 单飞行写链（chainTail）、失败保留 + 5s 退避重试（连续 3 次 → health failed）、entry 截断/queue 丢最旧 + dropped 计数、按大小轮换 `audit.jsonl.N`（保留既有条数 compact）；`record()` 返回 `{accepted,queued,dropped}`、`flush(deadline)` 返回 FlushReport、`health()` 落 §5.7 | `tests/unit/audit-writer.test.ts` 8 例 + 既有 `audit.test.ts`/`command.test.ts` 零回归 |
| session revision writer | revision 计数、快照先于 await 构建、写后 revision 比对决定 dirty + 100ms 补写、单飞行 saveChain | `tests/unit/session-revision.test.ts` 5 例 + 既有 `session.test.ts` 14 例零回归 |
| TempManager 跨进程配额 | `temp/.quota.json` 共享 ledger（tempLock 内读写、死 pid/超时残留回收）、容量核算 = 磁盘 + 跨进程 outstanding + 本进程 live outstanding、reserve/release/finalize/discard/sync 全接线（锁序 mutex→tempLock 不变） | `tests/unit/temp-quota.test.ts` 5 例 + 既有 `temp-manager.test.ts` 31 例零回归 |
| LRU oversized entry 保护 | `maxEntryBytes = maxMemoryBytes/2` 派生、`set()` 拒绝 + `oversizedRejected` 计数、stats 透出 | `tests/unit/cache-oversized.test.ts` 3 例 |
| truthful health | supervisor `getTerminationFailureCount()`、`SessionStore.health()`、`TempManager.health()`、`computeHealthStatus()` 聚合；`health://status` 输出 `status: healthy\|degraded\|failed` + `components{audit,temp,process,session}`；`telemetry_report` 增 audit state | `tests/unit/tools/utility.test.ts` 聚合 4 例 + `tests/tool-visibility.test.ts` e2e 断言 |
| state permissions 复核 | `ensureStateDir`/`ensureRoot`/`createStaging`/`atomicWriteFile`（0o700/0o600）全链路确认覆盖；轮换产物 `audit.jsonl.1` mode 0o600 断言（POSIX） | audit-writer 轮换用例 + 既有 path-policy/secret-governance 权限测试 |

## 2. 验收场景（roadmap #8 验收句逐条）

1. **并发写不丢最新 session**：`a mutation during the write window is re-saved, not lost`——flush 同步阶段捕获快照后立即变更，写完成后 revision 比对安排补写，磁盘内容含新 key；`concurrent flush and debounced save serialize` 断言最新 revision 落盘。旧实现缺陷（写后无条件 `dirty=false` 吞掉写窗口内变更）已消除。
2. **audit 写失败可见且不静默丢记录**：`write failure retains entries and health degrades; retry succeeds without loss`——logs 目录被文件占位时 flush 报 `clean:false`、条目滞留（queued=2）、health degraded；条件修复后重试按原顺序落盘零丢失；`three consecutive write failures put health into failed` 断言 failed 迁移与 lastError 透出；index.ts 关停链对 `flush(3000)` 的 `clean:false` 置 `exitCode=1` 并记 `audit-flush-incomplete`。
3. **entry/queue/file 大小受限**：oversized entry 截断为 `{truncated:true}` 骨架仍记录（64KiB 上限）；队列 10→5 条丢最旧且 `dropped=5`；文件 >64KiB 轮换出 `audit.jsonl.1`（内容超限、当前文件有界/待重建、POSIX mode 0o600）。`flush deadline stops retrying a failing sink` 断言 deadline 语义与剩余 bytes 上报。
4. **跨进程 temp quota 不超限且长操作不会被错误接管**：`foreign live outstanding blocks a reserve`（ppid 充当存活他进程，700+500 > 1000 拒绝）、释放后成功、死 pid 残留被回收、本进程预留镜像进 ledger、容量拒绝 → temp health degraded；lock 侧 `live heartbeat prevents takeover regardless of hold duration` 断言心跳存活时 80ms stale 窗口内无法接管、`stale takeover increments fence` 断言接管 fence+1、`release never removes another owner's lock` 断言释放安全。
5. **health 不再无条件报告 ok**：`health://status` e2e 断言 `status ∈ {healthy,degraded,failed}` 且 `components` 四键齐全（audit/process/session/temp）；聚合单测覆盖 healthy/degraded/failed 优先级；`telemetry_report` 文本含 `state=`。
6. **migration lock 死 owner 接管**：`dead owner is taken over immediately`（ESRCH 注入 → fence 4→5 立即接管）；corrupt 锁在 `takeoverOnCorrupt:false`（migration 语义）下超时 fail-closed 且锁文件原样保留——兼容 4.5 协议既有契约（`state-migration.test.ts` 零回归）。
7. **契约不变**：工具数 27（e2e tools/list）、工具 I/O 契约与错误码零变化、audit/session 文件格式向后兼容（JSONL/JSON 字段不变，轮换代文件为新增产物）；`record()` 返回值变更对全部既有调用点（忽略返回值）源码兼容。

## 3. 实现期审计与修正（代用户多轮审计）

| 轮次 | 发现 | 修正 |
|---|---|---|
| 设计 Round 1 | Windows rename 语义（REPLACE_EXISTING）使"rm+rename 接管窗口"风险整条不成立；heartbeat 迟到覆写竞态未说明；FlushReport.bytes 未定义；pid 复用局限未记录；`health()` 契约是同步签名；temp lock 错误映射兼容性 | 重写接管路径为 staging+rename 单步；补 token 验证停跳语义；补 bytes/局限/同步签名定义；`LockLeaseTimeoutError` 边界映射回 `TempLockTimeoutError` |
| 设计 Round 2 | 契约覆盖复核（§5.7/§5.8 全项）+ 现有测试对"corrupt/未知迁移锁 fail-closed"的既有契约——与初稿"corrupt 按 stale 接管"冲突 | 新增 `takeoverOnCorrupt` 选项：temp 默认允许接管（防卡死清理），migration 显式关闭（保守 fail-closed）；既有 `state-migration` 测试零回归佐证 |
| 设计 Round 3 | 既有 `audit.test.ts` 将 `MCP_AUDIT_MAX_ENTRIES` 条数 compact 固化为契约，初稿"删除 compact"会破坏契约 | 改为**轮换与条数裁剪并存**（轮换管字节 bound、compact 管行数语义、次序轮换→裁剪），`MCP_AUDIT_MAX_ENTRIES` 语义不变 |
| 实现 Round A | ledger 滞后（markWritten 延迟同步）导致**同进程**容量核算双计——既有 `temp-manager` 两用例失败暴露 | 容量核算改为"跨进程条目取 ledger、本进程条目取内存 live 值"；ledger 保留 1s 尾去抖同步服务跨进程视图 |
| 实现 Round B | release 回调可能在本已持锁的 discard/finalize 内触发，ledger 移除再抢锁构成自死锁 | release 统一走延迟同步路径（dirty 标记 + 锁外定时批量增删），消除嵌套抢锁 |
| 实现 Round C | 新增 `.quota.json`/`.temp.lock` 被计入磁盘容量，挤占预算使既有容量边界测试失败（939+100>1000） | `dirSize` 排除协调元数据文件——协调文件不属于容量 payload，恢复原有边界数值 |
| 实现 Round D | `cleanupLockFailures` 累计制使一次瞬时锁竞争导致 temp health 永久 degraded | 改为**连续 ≥3 次**才 degraded（成功清理归零），累计次数仍单独如实报告；design 同步更新 |
| 验收 Round E | 测试污染事故：session 单例在模块导入时即缓存状态目录，session-revision 测试未 `resetStateDirCache()` 导致写入落到项目真实 `session.json` | 测试补 reset；被污染的真实文件已恢复（cwd 还原为项目根，仅 cwd 字段受影响，历史/env 未变）；该事故同时证实了 truthful-health 的价值——真实状态文件被外部改写时旧实现毫无可见信号 |

## 4. 行为收紧汇总（对外可见）

- audit 写失败从"splice 后静默丢"变为"保留重试 + health 降级 + FlushReport 可见"（B1）；
- audit 队列/单条/文件从无字节上限变为三层有界，超限丢最旧/截断/轮换均计数可观测（B2/B3/B4）；
- temp lock 长持锁从 60s mtime 强制接管变为"心跳存活不接管、真死才接管且 fence+1"（B5）；
- migration lock 从"崩溃残留永久阻塞启动"变为"owner 死亡自动接管"（B6，未知锁仍 fail-closed）；
- 双进程 temp 预留从互不可见变为共享 ledger 互见（B7）；
- 超大缓存条目从"排空后强插"变为"拒绝 + 计数"（B8）；
- session 写窗口变更从"可能丢失"变为"必补写"（B9）；
- `health://status` 从恒 `"ok"` 变为 `healthy|degraded|failed` + components（B10，README/CHANGELOG 注明客户端适配点）。

## 5. 门禁证据（最终全量，2026-08-29）

- `pnpm run gate` → **EXIT=0**（build → tsc → lint → test → latency → tools coverage 全链）
- 全量测试：**63 文件 / 786 用例全过**（新增 lock-lease 9 + audit-writer 8 + session-revision 5 + temp-quota 5 + cache-oversized 3 + 聚合/文案 4；既有 63 文件零回归）
- latency 基准：**24/24 passed**（非阻断档位照常执行）
- tools coverage（阈值 55/45/60/55）：**59.39 / 49.79 / 67.32 / 63.16 达标**
- lint：0 error（9 warning 均为既有历史告警，与本次改动无关）
- 临时目录：`TEMP/TMP/TMPDIR` 全程显式指向 `D:/ALL MCP/Enhanced Terminal MCP/.etmcp/test-tmp`，无 C 盘写入
- `git diff --check`：通过（无空白残留）

## 6. 遗留与归属

- **durable spool 文件**：按 §5.7 "保留待重试数据 **或** durable spool" 二选一，本条目选择有界队列重试；若未来需要跨重启的 audit 待写持久化，另立 issue。
- **按时间（daily）audit 轮换**：bytes-only（§7 明确不做，理由见 design）。
- **migration lock pid 复用局限**：死亡 owner 的 pid 被复用时表现为存活 → fail-closed 不接管，只损失可用性不损失安全（§3.1 已记录）。
- **`health://status` 客户端适配**：字面匹配 `"ok"` 的消费方需改按 `healthy|degraded|failed` 判读（CHANGELOG Changed 已注明）。
- **usage-guide "NEW in v3.1" 过期文案**：仍归属 #13 docs-and-architecture-closeout（#9 验收已记录）。
- **sandboxed capability 端到端 e2e、canonical CI gate、hostile-input suite**：归属 #12 security-and-mcp-conformance-gates。
