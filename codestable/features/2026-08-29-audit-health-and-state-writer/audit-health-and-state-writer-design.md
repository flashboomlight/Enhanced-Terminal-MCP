---
doc_type: design
slug: audit-health-and-state-writer
status: approved
created: 2026-08-29
last_reviewed: 2026-08-29
tags: [production-hardening, audit, health, state, lock-fencing, temp-quota]
roadmap: 2026-08-28-production-hardening#8
related_architecture: [enhanced-terminal]
---

# Design · audit-health-and-state-writer（production-hardening #8）

## 1. 目标与范围

关闭生产就绪审计 **OPS-01**（audit 写入串行化/轮换/失败可见、truthful health）、**OPS-02**（lock 的 owner/lease/fencing、跨进程容量失真、权限初始化）本条目负责的部分，以及 §5.7 AuditWriter / health 契约与 §8.2 "audit writer failure / state writer race / lock fencing" 验收行。

交付七件事：

1. **session revision writer**：变更计数 + 单飞行串行写入，修复 dirty 标记竞态，最新状态不丢；
2. **带 fencing 的锁原语**（新模块 `src/lock-lease.ts`）：owner 记录、lease heartbeat、fencing token 单调递增、stale 接管保留 fence、token 校验释放；temp lock 与 migration lock 共用；
3. **audit serialized writer**：单飞行写链、失败保留队列重试、entry/queue/file 三层 byte 上限、按大小轮换、`record()/flush()/health()` 落 §5.7 契约；
4. **TempManager 跨进程配额**：root 下共享 outstanding ledger（锁内记账 + 死进程回收），容量核算可见他人预留；
5. **LRU oversized entry 保护**：超过单条上限的 entry 拒绝入缓存并计数，不再排空全缓存后强插；
6. **truthful health**：`health://status` 的 status 从硬编码 `"ok"` 改为 audit/temp/process/session 四组件聚合的 `healthy|degraded|failed`；supervisor 暴露终止失败计数；
7. **state permissions 复核**：确认 page-cache/temp/state 全链路 0o600/0o700 已覆盖（#6 已做大部分，本条目补缺口）。

## 2. 现状与缺口（证据）

| # | 位置 | 现状 | 缺口 | 对应契约 |
|---|---|---|---|---|
| G1 | `src/session.ts:133-179` | `markDirty` 5s 去抖；`saveToDisk` 末尾 `this.dirty = false` | `atomicWriteFile` await 期间的新变更把 dirty 置 true，写入完成后被无条件清 false → 该次变更既不在已落盘快照里，又永远不会触发下次保存（flush 同样检查 dirty）。并发保存（debounce 触发与 shutdown flush 重叠）无串行化，旧内容可能晚于新内容 rename | "并发写不丢最新 session" |
| G2 | `src/audit.ts:90-105` | `flush()` 先 `queue.splice(0)` 再 `appendFile`；失败仅 warn | 写失败 = 条目永久丢失且不可观测；无重试 | §5.7 "失败不能静默丢失…不能从内存 queue splice 后静默丢失" |
| G3 | `src/audit.ts:90-118` | flush 可被 record/recent/shutdown 重入；append 与 compact 并发 | compact 读到旧内容、晚于 append 原子替换 → append 进来的行丢失；appendFile 顺序不保证 | "audit writer 单写入队列" |
| G4 | `src/audit.ts:25-27,107-118` | `MCP_AUDIT_MAX_ENTRIES`（条数）为唯一上限；compact 全量 `readFile` 进内存 | entry / queue / file 均无 byte 上限；compact 内存无界 | §5.7 "audit entry、队列和单文件都必须有 byte/count 上限" |
| G5 | `src/audit.ts:145-152`; `src/tools/utility.ts:469` | `summary()` 只有 mode/enabled；health 资源硬编码 `status: "ok"` | 无 `health()`、无 FlushReport、写失败/dropped 对外不可见 | §5.7 AuditWriter.health / FlushReport；"health 不再无条件报告 ok" |
| G6 | `src/temp-manager.ts:376-422` | stale 判定 = lock 文件 mtime > 60s → `rm` 后重抢；持锁期间无续租 | 长操作（如大目录 cleanup）超 60s 被另一进程强接管 → 双持锁；释放时 token 校验只能防"删别人的锁"，防不了接管本身 | §5.8 "temp/migration lock 采用相同的 owner、lease heartbeat 和 fencing token 语义；stale takeover 不能只根据 mtime rm" |
| G7 | `src/state-dir.ts:225-239` | migration lock：wx 抢占 50×100ms，超时 fail-closed | 崩溃进程遗留的锁文件使启动永久失败（无 owner liveness / stale 回收） | OPS-02 |
| G8 | `src/temp-manager.ts:332-349` | 容量核算 = 本进程 `diskBytesCached()`（2s 缓存）+ 本进程 reservations | 跨进程 outstanding 不可见：两进程各 reserve 大额可叠加超限 | "跨进程 temp quota 不超限" |
| G9 | `src/cache.ts:97-116` | `evictIfNeeded` 循环在缓存空且 incoming 仍超 maxMemoryBytes 时 break 后照插 | 单条超大 entry 可占据全部内存预算且清空全部热条目 | "LRU oversized entry 保护" |
| G10 | `src/tools/utility.ts:457-494` | health 资源四组件信息齐全但无聚合状态 | temp cleanup 失败 / audit 写失败 / supervisor 终止失败 / session persist 失败均不反映到 status | "health 的状态必须反映 audit/temp/process 的 degraded/failed 状态" |

不做为缺口的点：`recoverStaleStaging` 已有 `.heartbeat` 续租 + lease 判定（staging 生命周期管理正确，仅 lock 本身缺 fencing）；state/temp/page-cache 根创建的 0o700 与 no-follow 在 #5/#6 已覆盖（`ensureStateDir`/`ensureRoot`/`createStaging` 均带 mode + `assertSafeStateRoot`），本条目只补测试与漏点复核。

## 2.5 结构健康度

- `src/lock-lease.ts` 新模块约 150-200 行，单一职责（文件锁 + lease/fencing），temp-manager 与 state-dir 复用，消除两处手写锁的漂移；
- `audit.ts` 当前 164 行，加入 writer 契约后预计 ~300 行，仍在单屏×3 内；`record/flush/health` 职责清晰，无第四参数新增（配置读取保持模块级函数）；
- `session.ts` 当前 264 行，revision writer 增量 ~40 行，无新职责；
- `temp-manager.ts` 756 行已偏大，本条目**只做原地增量**（ledger 记账 + health 面约 80 行），不借机重构；ledger 逻辑独立成私有方法簇，后续若继续膨胀应另立 refactor issue 拆 quota 子模块；
- `cache.ts` 增量 ~15 行（reject + 计数）；
- `utility.ts` health 资源增量 ~30 行（聚合函数独立）；
- 新增单测文件：`tests/unit/lock-lease.test.ts`、`tests/unit/audit-writer.test.ts`、`tests/unit/session-revision.test.ts`、`tests/unit/cache-oversized.test.ts`（或并入现有 cache 相关测试）；temp 跨进程配额测试并入 `tests/unit/temp-manager.test.ts` 风格的独立文件。

## 3. 分项设计

### 3.1 `src/lock-lease.ts` — 带 fencing 的文件锁

```ts
interface LockInfo { pid: number; at: number; token: string; fence: number; }
interface AcquireOptions {
  timeoutMs: number;        // 抢锁等待上限（超时抛 LockLeaseTimeoutError）
  staleMs: number;          // heartbeat 缺失多久判定 stale
  heartbeatMs: number;      // 持锁续租间隔；0 = 不续租
  onStale?: (prev: LockInfo) => void;   // 接管观测点（告警/审计）
}
async function withFencedLock<T>(lockPath: string, opts: AcquireOptions, fn: (lock: AcquiredLock) => Promise<T>): Promise<T>;
interface AcquiredLock { readonly token: string; readonly fence: number; }
```

语义：

- **抢占**：`wx` 写 `{pid, at, token, fence: 1}`。新锁（无既有文件）fence 从 1 起；从 stale 锁接管时**读旧 fence +1**，写入同目录 staging 后 `rename` 到锁路径——Node 在 Windows 上 rename 即 MoveFileEx(REPLACE_EXISTING)，可直接原子替换已存在的锁文件，无需先 `rm`（两进程并发接管时 rename 后到者胜，先到者经 fencing 检测发现失锁，不会双持破坏）。
- **stale 判定**：接管必须"可证明 stale"——锁内容 `at`（heartbeat 刷新，非 mtime）距今 > `staleMs`，或 owner 可证已死（liveness 注入）；内容损坏（owner 不可知）仅在 `takeoverOnCorrupt` 允许时才接管：**temp lock 允许**（否则损坏锁会永久卡死清理），**migration lock 不允许**（4.5 协议既有契约：未知锁 fail-closed 保留，绝不破坏）。持锁方以 `heartbeatMs` 周期重写自身 `at`（staging+rename 替换，重写前验证 token 仍是自己的）；若持有者在写入时观察到外来 token，立即停止心跳并视为 fence lost（防慢持有者的迟到心跳覆盖接管者）。只要心跳存活，**无论持锁多久都不被接管**——直接修复 G6。
- **fencing**：返回 `fence` 供调用方在破坏性动作前 `assertFence`（重读锁文件，token/fence 不再属于自己则抛 `LockFenceLostError`）。temp cleanup 的删除步骤前调用一次，锁丢失则本轮放弃（沿用现有"锁超时降级本轮放弃"路径）。
- **释放**：读-验证 token 是自己才 `rm`；不是（已被接管）静默不删。
- **异常面**：`LockLeaseTimeoutError`（超时，调用方降级）、`LockFenceLostError`（fencing 丢失，调用方放弃本操作）。锁文件损坏（JSON 解析失败）按 stale 处理 + 告警。
- **TempManager 接线**：`withTempLock` 内部换用 `withFencedLock`，对外签名不变；`LockLeaseTimeoutError` 在边界映射为既有的 `TempLockTimeoutError`（现有 cleanup 的 catch 分支与测试依赖该类型）；cleanup 在进入删除阶段前用返回的 lock 做 `assertFence`，失锁则沿用"本轮放弃"路径。

迁移锁（G7）复用同模块，选项：`heartbeatMs: 0`（迁移短事务不续租）、stale 判定增加 **owner liveness**：`at` 未过期但 `process.kill(pid, 0)` 报 ESRCH（owner 已死）→ 立即接管；owner 存活则按原超时 fail-closed（活进程的迁移不允许强抢）。锁路径仍是 `<stateDir>/.migration.lock`，行为兼容。已知局限：pid 复用可能让死 owner 显得存活——方向是 fail-closed（不接管、重试至超时），只损失可用性不损失安全，接受并在验收记录。

### 3.2 session revision writer（G1）

- `markDirty()` 同时 `this.revision++`；`saveToDisk()` 入口记 `revAtSnapshot = this.revision`，序列化快照（把快照构建移到任何 await 之前，先捕获再落盘）；
- 写成功后：`this.dirty = this.revision !== revAtSnapshot`；若 dirty 且无定时器 → 立即安排一次 100ms 的补写（不再等 5s）；
- 串行化：`saveChain: Promise<void>`（单飞行写链，每个 save 排队在前一个之后），`flush()` 也经 chain，消除 debounce 与 shutdown flush 的并发 rename 乱序；
- flush 返回 void 保持不变；index.ts 关停链路不改顺序（drain → session.flush → audit.flush）。

### 3.3 audit serialized writer（G2/G3/G4/G5）

重写 `AuditLog` 内部，保持 `record(entry)` 签名兼容（返回值从 void 变为 `{accepted, queued, dropped}`，现有调用点全部忽略返回值，无破坏）：

- **入队**（record）：mode 过滤 + redact（不变）；序列化单条后超 `MCP_AUDIT_MAX_ENTRY_BYTES` 的条目：detail 替换为 `{truncated: true, originalBytes}`、error 截断，仍记录（不整条丢弃，保证操作可观测）；队列超 `MCP_AUDIT_QUEUE_MAX_ENTRIES` 或 `MCP_AUDIT_QUEUE_MAX_BYTES` 时丢最旧并 `droppedCount++` + warn；
- **串行写链**：`writeChain: Promise<void>`，flush 将写任务 append 到链尾（前一个完成才开始），appendFile 顺序 = 入队顺序；compact/rotation 只在链内执行；
- **失败保留**：写任务先 peek 队列头部的批次（不再 splice），`appendFile` 成功才移除；失败保留全部条目、`consecutiveFailures++`，按 5s 退避重排（最多连续 3 次失败后转入 `failed` 态，条目继续保留，后续 record 触发的新 flush 仍会再试）；
- **轮换 + 条数裁剪并存**：写成功后 `stat` 更新 lastFileSize，`size > MCP_AUDIT_MAX_FILE_BYTES` → 删最旧 `audit.jsonl.<N>`、当前改名 `audit.jsonl.1`；保留 `MCP_AUDIT_MAX_ROTATIONS`（默认 1）代。既有 `MCP_AUDIT_MAX_ENTRIES` 条数 compact **保留原语义**（现有测试与文档已将其固化为契约），在轮换之后执行，内存 bound 由轮换保证（文件 ≤ 8 MiB 才会被 compact 读入）。轮换只在写成功后检查：文件存在写成功前的瞬时超限窗口，属于可接受的有界滞后（下一次成功写必触发轮换）；`health().bytes` 取自写路径缓存的最近已知大小（`health()` 为同步契约，避免每次 stat）。
- **契约面**：
  - `record(entry): {accepted: boolean; queued: number; dropped: number}`；
  - `flush(deadlineMs?: number): Promise<FlushReport>`（`{clean, queued, bytes, dropped, error?}`；`bytes` = flush 结束时仍滞留队列的估算字节数，`queued` = 滞留条数；deadline 到仍有未写条目 → `clean: false`）；
  - `health(): {state: "healthy"|"degraded"|"failed"; queued: number; bytes: number; dropped: number; lastError?: string}`——dropped>0 或 consecutiveFailures∈[1,2] → degraded；consecutiveFailures≥3 → failed；否则 healthy；bytes 为当前文件大小（stat 失败为 0 并降级）；
  - `summary()` 保留并附加 `state/dropped`（telemetry_report 文案同步）。

### 3.4 TempManager 跨进程配额（G8）

- root 下共享 ledger 文件 `.quota.json`：`{reservations: {[id]: {pid, bytes, at}}}`，全部读写都在 `withTempLock` 内；
- `reserveBytesLocked`（重命名语义调整为"锁内记账"）流程：抢 temp lock → 读 ledger → 回收脏条目（`process.kill(pid,0)` ESRCH，或 at 距今 > 10min）→ `used(diskBytesCached) + 他人outstanding + additional > max` 则抛 `TempCapacityExceededError` → 写入自己条目；
- release/finalize/discard 释放时同步删除 ledger 中自己的条目（锁内）；崩溃残留由下一个持锁者的死进程回收清理；
- 锁内记账使 `diskBytesCached` 的 2s 缓存风险可接受：outstanding（最易漂移的部分）已被 ledger 覆盖，磁盘 truth 略滞后由 cleanup 第④步兜底；
- 死锁序约定：mutex → withTempLock（与现有 `createStaging` 一致），reserve 侧同序，无反向嵌套。

### 3.5 LRU oversized entry 保护（G9）

- `LRUCache` 新增 `maxEntryBytes = max(1, floor(maxMemoryBytes / 2))`（构造派生，不加配置面）；
- `set()` 中 `bytes > maxEntryBytes` → `oversizedRejected++` 直接返回，不进缓存、不清热条目；
- `stats` 增加 `oversizedRejected` 字段（health 资源的 cache 对象自动带出）；
- 当前响应预算 2 MiB < 16 MiB 派生上限，正常流量不触发，属于纯防护面。

### 3.6 truthful health（G10）

- `ProcessSupervisor` 增加私有计数器 `terminationFailures`（在现有 `entry.state.terminationFailed = true` 处同步 ++），暴露 `getTerminationFailureCount(): number`；
- `SessionStore.health(): {state, persistFailures, dirty}`——最近一次 persist 失败且 dirty → degraded，否则 healthy；
- `TempManager.health(): {state, capacityExceededRecent, cleanupLockFailures, consecutiveCleanupLockFailures}`——reserve 抛容量错误时置 `capacityExceededAt`（5min 内视为 degraded）；cleanup 锁超时/fencing 丢失**连续 ≥3 次**才 degraded（单次瞬时竞争不降级，成功清理即归零；累计次数仍单独如实报告）；
- `utility.ts` 新增聚合 `computeHealthStatus()`：任一 failed → `failed`；任一 degraded → `degraded`；否则 `healthy`；health 资源输出 `status` 字段 + `components: {audit, temp, process, session}` 明细（各自 state 与关键计数）；
- `telemetry_report` 文本追加 `Audit state: <state> (queued=N, dropped=N)` 一行。

### 3.7 state permissions 复核

- 确认 `ensureStateDir`/`ensureRoot`/`createStaging`/`atomicWriteFile`（0o700/0o600）已覆盖 session.json、audit.jsonl、temp、page-cache staging（#5/#6 已落地）；
- 补齐测试：temp 根、audit logs 目录、session.json 落盘后在 POSIX 下 mode 断言（Windows 跳过）；rotation 后的 `audit.jsonl.1` mode 仍 0o600。

## 4. 配置表（新增环境变量，全部严格整数解析）

| 变量 | 默认 | 约束 | 语义 |
|---|---|---|---|
| `MCP_AUDIT_QUEUE_MAX_ENTRIES` | 2000 | ≥1, ≤100000 | 内存队列条数上限；超限丢最旧并计入 dropped |
| `MCP_AUDIT_QUEUE_MAX_BYTES` | 4194304 (4 MiB) | ≥1024 | 内存队列字节上限；超限丢最旧并计入 dropped |
| `MCP_AUDIT_MAX_ENTRY_BYTES` | 65536 (64 KiB) | ≥1024 | 单条 entry 序列化字节上限；超限截断 detail/error 保留骨架 |
| `MCP_AUDIT_MAX_FILE_BYTES` | 8388608 (8 MiB) | ≥65536 | 单文件字节上限；写成功后超限触发轮换 |
| `MCP_AUDIT_MAX_ROTATIONS` | 1 | 0–10 | 保留 `audit.jsonl.N` 代数；0 = 轮换时直接删除不保留 |

锁参数（heartbeat 10s / stale 60s / temp lock timeout 5s / migration liveness 判定）保持代码常量，不新增配置面。`MCP_AUDIT_MAX_ENTRIES`（默认 10000）语义不变：条数 compact 窗口 + `recent()` 读取窗口。

## 5. 行为变化表（对外可见）

| # | 场景 | 变化前 | 变化后 |
|---|---|---|---|
| B1 | audit 写失败（磁盘满/权限） | 条目已从队列移除，静默丢失，仅 logger.warn | 条目保留在队列按退避重试；`health()` 转 degraded→failed；FlushReport `clean:false` |
| B2 | audit 队列积压超上限 | 无上限，内存无界 | 丢最旧 + `dropped` 计数 + warn + health degraded |
| B3 | 单条 audit entry 超大 | 无上限全量落盘 | detail/error 截断为骨架（truncated 标记），仍记录 |
| B4 | audit 文件超 8 MiB | 无轮换（仅条数 compact） | 轮换为 `audit.jsonl.1`（保留 1 代），单文件大小有界 |
| B5 | 持 temp lock 超过 60s 的长操作 | 被其他进程 mtime 接管 → 双持锁 | 心跳存活即不被接管；真死进程按 stale 接管且 fence+1 |
| B6 | 崩溃进程遗留 `.migration.lock` | 启动 5s 重试后永久 fail-closed | owner pid 已死 → 自动接管继续迁移 |
| B7 | 双进程同时向同一 temp root reserve | 各自只看本进程 outstanding，可叠加超限 | 共享 ledger 互见他人 outstanding，超限抛 TempCapacityExceeded |
| B8 | 超大结果尝试入结果缓存 | 清空全部热条目后仍强插 | 拒绝入缓存 + oversizedRejected 计数 |
| B9 | session 写盘期间发生新变更 | dirty 标记被清掉，变更可能直到关停才落盘（甚至丢失） | revision 检测 → 立即补写，最新状态不丢 |
| B10 | `health://status` 的 `status` 字段 | 恒为 `"ok"` | `healthy|degraded|failed` + components 明细（客户端若字面匹配 "ok" 需适配——见 §8 兼容性说明） |
| B11 | audit `record()` 返回值 | void | `{accepted, queued, dropped}`（现有调用点忽略返回值，源码兼容） |

错误码无新增（`TempCapacityExceededError`/`TempLockTimeoutError` 已存在；锁模块新增两个 Error 类仅内部使用，不进工具错误面）。

## 6. 测试矩阵

| 域 | 用例 |
|---|---|
| lock-lease | 抢占写 fence=1；stale 接管 fence+1 且原文件被原子替换；heartbeat 存活的长持锁不被接管（fake timer）；heartbeat 停止超 staleMs 后可接管；释放 token 校验（不删他人锁）；fence 丢失抛 LockFenceLostError；损坏锁文件按 stale 处理；migration owner 死亡（kill(pid,0) ESRCH 注入）立即接管 |
| audit writer | 写失败条目保留且重试成功后顺序落盘（注入失败 fs 或只读目录）；连续失败 3 次 health=failed；队列条数/字节超限丢最旧 + dropped；超大 entry 截断保留骨架；文件超限轮换且 audit.jsonl.1 保留 0o600；flush(deadline) FlushReport 字段；recent() 在轮换后仍可读当前文件；record 返回契约字段 |
| session revision | 写盘 await 期间 setEnv → 写完后 dirty 仍 true 并补写，磁盘内容含新 key；debounce 与 flush 并发不交错（chain 串行断言：最终文件为最新 revision）；flush 幂等（无 dirty 时不写） |
| temp quota | 同 root 两个 TempManager 实例：A reserve N 字节后 B reserve 超 max-N 抛容量错误；A 释放后 B 成功；注入死 pid 的 ledger 残留被回收；capacityExceeded → temp health degraded |
| cache | 单条 > maxEntryBytes 拒绝 + oversizedRejected=1；边界内正常缓存命中；stats 字段存在 |
| health | 全组件健康 → healthy；注入 audit 失败 → degraded；audit 连续失败 → failed 聚合；temp capacityExceeded → degraded；supervisor 注入 termination 失败 → degraded；session persist 失败 → degraded |
| e2e | `health://status` 返回 `status` ∈ {healthy,degraded,failed} 且 components 四键齐全；telemetry_report 含 Audit state 行；27 工具数不回归 |

## 7. 明确不做

- **不实现独立 durable spool 文件**：§5.7 允许"保留待重试数据**或** durable spool"二选一，选有界队列重试（队列本身有 count/byte 上限，超限 dropped 可观测），避免再引入一个需要轮换/清理/权限治理的状态文件；
- **不做按时间（daily）轮换**：§5.7 "按 bytes/time 轮换"读作二选一；本 server 为单用户 local profile，时间轮换只增加空目录扫描与句柄管理，字节上限才是内存/磁盘 bound 的来源，选 bytes-only 并在 README 注明；
- **不用 OS 文件锁（flock/LOCKFILE_EXCLUSIVE_LOCK）**：跨平台语义差异大且 Node 无内建；wx + heartbeat + fencing 为等价实现，Windows/Unix 行为一致；
- **不在 audit 写失败时阻断高风险操作**：§5.7 允许"阻断高风险操作或显式 degraded"二选一，选 degraded 可观测（本 server 为 local 单用户 profile，阻断会直接伤害可用性）；
- **不做跨进程 session writer**：§5.0 明确一个 server 进程绑定一个 stdio client / worker，session 只有单写者，revision writer 只解决进程内竞态；
- **不重构 temp-manager 大文件**：只做原地增量（见 §2.5），拆分另立 refactor；
- **不新增运行时依赖**；
- **不改 supervisor 的 termination 行为**：只加只读计数器；
- **不改 telemetry_report / health 的既有字段语义**（只新增字段；`status` 字段值域变化见 B10）。

## 8. 兼容性说明

- `health://status` 的 `status` 从恒 `"ok"` 变为 `healthy|degraded|failed`：MCP resource payload 不在工具 I/O 契约保护范围内，且是 roadmap 明文要求（"health 不再无条件报告 ok"）；CHANGELOG 以 Changed 记录；
- audit 文件格式不变（JSONL，字段不变），`recent()` 与外部消费兼容；轮换代文件 `audit.jsonl.1` 为新增产物；
- `session.json` 格式不变；
- 工具数量、工具 I/O 契约、错误码完全不变。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 并发接管时 rename 后到者胜，先到者短暂"以为持锁" | 先到者下一次 assertFence/心跳即发现外来 token（fence lost），释放路径 token 校验也不会误删他人锁；破坏性删除前强制 assertFence |
| 慢持有者迟到心跳覆盖接管者新锁 | 心跳写前验证 token；发现外来 token 立即停跳并标记 fence lost；接管前提是心跳缺失超 staleMs，活持有者正常不会进入该窗口 |
| heartbeat 定时器阻止进程退出 | 所有 timer `unref()`（沿用现有约定） |
| writeChain 无界增长 | chain 只串行化写任务本身（每个任务在链上只挂一个 promise），record 高频只入队不入链；flush 合并去重（链上已有 pending flush 则复用） |
| ledger 文件损坏 | JSON 解析失败按空 ledger 处理 + warn，容量核算退回磁盘 truth，不阻塞 reserve |
| 测试中 fake timer 与真实 fs 交互 | lock 测试用真实 fs + 短常量注入（构造参数允许覆盖 staleMs/heartbeatMs），不用 vi.useFakeTimers 控制 fs 时间戳 |

## 10. 验收映射

| roadmap #8 验收句 | 证据 |
|---|---|
| 并发写不丢最新 session | §3.2 + session revision 测试（写入期间新变更补写、chain 串行） |
| audit 写失败可见且不静默丢记录 | §3.3 + 失败保留/重试/health 测试；B1 |
| entry/queue/file 大小受限 | §3.3 三层上限 + 截断/丢最旧/轮换测试 |
| 跨进程 temp quota 不超限且长操作不会被错误接管 | §3.1/§3.4 + 双实例配额测试、heartbeat 长持锁测试 |
| health 不再无条件报告 ok | §3.6 + 聚合测试、e2e status 断言 |
