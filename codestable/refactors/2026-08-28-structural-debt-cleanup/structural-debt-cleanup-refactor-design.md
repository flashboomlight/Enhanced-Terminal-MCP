---
doc_type: refactor-design
refactor: 2026-08-28-structural-debt-cleanup
status: approved
scope: command.ts 前奏去重 + paging/temp-manager 结构拆分 + adaptive/scan 清理
summary: 按用户 2026-08-28 授权（「照你说的办，最后我要你解决全部债务」）执行 scan 全部 5 条，R4→R5→R1→R3→R2 顺序，全程行为等价、facade 保 API
---

# structural-debt-cleanup refactor design

> 放行依据：用户 2026-08-28 原话「照你说的办，最后我要你解决全部债务」，对 scan 全部 5 条明确放行；本项目无前端 UI（AGENTS.md「UI 验证要求」），全部验证责任为 AI 自证（五门禁）。

## 1. 本次范围

- 从 scan 勾选：R1、R2、R3、R4、R5（全部，无 ✗ 项）
- 明确不做：批处理闸位形态差异（batch_execute 的整批语义保留现状，仅复用无差异 helper）；temp-manager 的 TempManager 类体内部分解（类职责内聚，本次只拆基础设施层）；任何对外契约/错误码/输出 schema 变化
- 预估总工作量：约 770 行迁移 + 3 个新文件 + 2 个文件瘦身；总风险档位低-中

## 2. 前置依赖

- 测试覆盖：R1 依赖 tests/e2e-latency.test.ts（已覆盖三工具全行为）+ tests/unit/tools/command.test.ts；R2 依赖 tests/unit/paging.test.ts（已有）；R3 依赖 tests/unit/temp-manager.test.ts（已有）；R4/R5 依赖 tests/unit/infra.test.ts、tests/unit/core.test.ts（已有，R5 同步改测试导入）。均无需补刻画测试
- 调用方搜索：R2/R3 拆分采用 facade re-export，外部 `from "./paging.js"` / `from "./temp-manager.js"` 调用方零改动（实施时 grep 复核）

## 3. 执行顺序

### 步骤 1：裁剪 DEFAULT_TIMEOUTS 死条目
- 引用方法：M-L3-07
- 具体操作：`src/adaptive.ts` DEFAULT_TIMEOUTS 收缩为 `{ execute_command: 30000 }`；`export { DEFAULT_TIMEOUTS }` 与函数签名不动
- 退出信号：`pnpm exec vitest run tests/unit/infra.test.ts tests/unit/upgrades-r2.test.ts` 全绿
- 验证责任：AI 自证
- 回滚：git checkout src/adaptive.ts

### 步骤 2：scan.ts 弃用再导出迁移
- 引用方法：M-L2-04
- 具体操作：`tests/unit/core.test.ts` 改从 `../../src/security.js` 导入 `isSensitivePath`（原 isCredentialFilePath 断言改名）；删除 `src/scan.ts:70-72` 弃用再导出
- 退出信号：`pnpm exec vitest run tests/unit/core.test.ts` 全绿 + `grep -rn isCredentialFilePath src/ tests/` 零命中
- 验证责任：AI 自证
- 回滚：git checkout 两文件

### 步骤 3：command.ts 前奏提取
- 引用方法：M-L2-01
- 具体操作：在 src/tools/command.ts 内提取三个模块级 helper——`resolveCommandLimits()`（getCommandOutputLimits + VALIDATION_ERROR fail 包装）、`prepareInvocation(command, cwd)`（getShellSpec + buildShellInvocation + session cwd 合并）、`finishCommandEnvelope(result, t0, errorMessage?)`（commandError + buildCommandEnvelope + error 挂载）；execute_command 与 watch_command 改调；batch_execute 仅复用无差异 helper
- 退出信号：`pnpm exec vitest run tests/unit/tools/command.test.ts` + `pnpm run build` + `pnpm exec vitest run tests/e2e-latency.test.ts` 全绿
- 验证责任：AI 自证
- 回滚：git checkout src/tools/command.ts（依赖 build 时先 pnpm run build）

### 步骤 4：temp-manager 拆分
- 引用方法：M-L3-07
- 具体操作：新建 `src/temp-core.ts` 迁入 helpers（isInside/isSafeSubdirId/lstatOrNull/readFileOrNull/sleep）、环境读取器（getTempTtlMs/getMaxTempDirs/getCleanupIntervalMs/getMaxTotalBytes）、STAGING 两常量、TempCapacityExceededError/TempLockTimeoutError、AsyncMutex、TempDir/TempStats/TempReservation/TempStaging 接口、ReservationImpl；`temp-manager.ts` 保留 TempManager + 单例并显式 re-export temp-core 公开符号
- 退出信号：`pnpm exec vitest run tests/unit/temp-manager.test.ts` 全绿 + tsc 零错误 + grep 确认外部仅从 temp-manager.js 导入且符号齐全
- 验证责任：AI 自证
- 回滚：删除 temp-core.ts + git checkout temp-manager.ts

### 步骤 5：paging 拆分
- 引用方法：M-L3-07
- 具体操作：新建 `src/paging/` 三模块——`codec.ts`（PageEncoding/readUtf8Unit/readGbkUnit/readUnit/isValidUtf8/detectEncoding/expectedUnitBytes/decodeCompleteUnits）、`index-format.ts`（IndexRecord/buildIndex/encodeIndex/readIndex/findCheckpoint/findEndByte 及索引常量）、`paths.ts`（isInside/isSafeNumber/clampPageSize/assertRegularPath/assertFourFiles）；`paging.ts` 保留公开类型/错误/writer/reader 编排并 re-export 三模块公开符号
- 退出信号：`pnpm exec vitest run tests/unit/paging.test.ts` 全绿 + tsc 零错误 + 公开符号 re-export 清单 grep 复核
- 验证责任：AI 自证
- 回滚：删除 src/paging/ 目录 + git checkout src/paging.ts

### 步骤 6：收尾全量门禁
- 具体操作：`pnpm run build && pnpm exec tsc --noEmit && pnpm run lint && pnpm test && pnpm run test:latency`
- 退出信号：五门禁全绿
- 验证责任：AI 自证
- 回滚：不适用（验证步）

## 4. 风险与看点

- 高风险步骤：步骤 5（paging 拆分）——注意 codec 与 index-format 之间的单向依赖（index-format 可用 codec，codec 不得反向 import），facade re-export 用显式符号清单而非 `export *`，避免 API 漂移
- 容易出错的点：①步骤 3 中 watch_command 的 `commandError(result, "Watch command")` 带第二参，提取 finishCommandEnvelope 时参数化；②temp-core 迁移后 temp-manager 内部引用要从本地符号改为 import，漏改会 tsc 报错（安全网）；③两处拆分后 build 产物路径变化（build/paging/index-format.js 等），e2e 子进程不受影响但需先 build
