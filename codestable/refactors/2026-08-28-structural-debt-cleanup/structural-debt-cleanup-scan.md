---
doc_type: refactor-scan
refactor: 2026-08-28-structural-debt-cleanup
status: user-reviewed
scope: src/tools/command.ts、src/paging.ts、src/temp-manager.ts、src/adaptive.ts、src/scan.ts 及对应单测（tests/unit/paging.test.ts、tests/unit/temp-manager.test.ts、tests/unit/infra.test.ts、tests/unit/core.test.ts、tests/e2e-latency.test.ts）
summary: 发现 5 条优化点：结构 2 / 可读性 2 / 死配置 1；低风险 4 / 中风险 1；建议按 R4→R5→R1→R3→R2 顺序执行
---

# structural-debt-cleanup scan

## 总览

- 扫描范围：src/tools/command.ts、src/paging.ts、src/temp-manager.ts、src/adaptive.ts、src/scan.ts + 五个对应测试文件
- 发现 5 条优化点：结构 2（R2/R3）/ 可读性 1（R1）/ 死配置 1（R4）/ 遗留迁移 1（R5）
- 按风险：低 4 / 中 1（R2，文件最大但测试保护最厚）
- 建议先做：R4 → R5 → R1（微改动、AI 可自证），后做 R3 → R2（结构拆分，facade 保 API）
- 建议慎做 / 后做：R2 放最后（1141 行最大动点，靠 200+ 行单测兜底）
- 前置检查 7 条全过：✓（无行为改动夹带；五模块均有测试覆盖；单模块内问题；非口味项；命令.ts 同文件仅 R1 一条；范围 5 源文件 + 5 测试文件）

> 用户勾选记录：2026-08-28 用户在债务盘点报告后明确指示「照你说的办，最后我要你解决全部债务」，对本清单 5 条全部放行（即全部 ✓），无 ✗ 项。

## 条目

### [R1] 提取 execute/watch 两处共享的命令执行前奏 ✓

- **位置**：`src/tools/command.ts:342-372`（execute_command）与 `src/tools/command.ts:645-671`（watch_command）
- **分类**：可读性
- **现状**：两个 handler 各自重复「precheckCommand → getCommandOutputLimits → commandSafetyGate → getShellSpec/buildShellInvocation/cwd 解析 → runCommandOutput → envelope 构建」六步骨架，仅 rate limit、超时来源、timeoutMode、audit detail 有差异
- **问题**：六步骨架重复 2 次（每处约 25 行）；安全闸调用点形态不一致是已知结构债，任何闸位逻辑调整需同步改 2-3 处
- **建议**：提取 `resolveCommandLimits()`（limits 校验 + fail 包装）、`prepareInvocation()`（shellSpec + invocation + effectiveCwd 三行解析）、`finishCommandEnvelope()`（result→error→envelope 收尾）三个纯函数，两个 handler 改为调用；batch_execute 仅复用无差异的部分
- **建议映射的方法**：M-L2-01（Extract Function）
- **风险**：低（纯提取，不改调用顺序与参数；e2e 覆盖三个工具全部行为）
- **验证**：AI 自证（tests/e2e-latency.test.ts + tests/unit/tools/command.test.ts + tsc）
- **范围**：约 60 行 / 1 文件

### [R2] 把 paging.ts 按职责拆为 codec/index-format/paths 三模块 ✓

- **位置**：`src/paging.ts`（1141 行，UTF-8/GBK 字节解码、缓存索引格式、路径断言、staging IO、meta 解析混装一文件）
- **分类**：结构
- **现状**：`readUtf8Unit/readGbkUnit/readUnit/isValidUtf8/detectEncoding/expectedUnitBytes`（字节编解码）、`buildIndex/encodeIndex/readIndex/findCheckpoint`（索引格式）、`isInside/isSafeNumber/assertRegularPath/assertFourFiles`（路径安全）、writer/reader 编排同文件
- **问题**：1141 行承担 4 类职责；任何一块改动都在千行文件内定位；唯一超过 1000 行的源文件
- **建议**：新建 `src/paging/` 目录，拆出 `codec.ts`（字节单元解码 + 编码探测）、`index-format.ts`（索引记录编解码 + checkpoint 定位）、`paths.ts`（路径断言 + 数值夹取）；`paging.ts` 保留编排与公开 API 并 re-export 全部公开符号，外部 import 路径零变化
- **建议映射的方法**：M-L3-07（Single Responsibility Split）
- **风险**：中（最大文件，但 tests/unit/paging.test.ts 200+ 行直接覆盖公开行为；facade 保证 API 不动）
- **验证**：AI 自证（tests/unit/paging.test.ts + tsc + grep 确认公开符号 re-export 齐全）
- **范围**：约 450 行迁移 / 4 文件新增 1 文件瘦身

### [R3] 把 temp-manager.ts 的 helpers/类型/错误拆到 temp-core.ts ✓

- **位置**：`src/temp-manager.ts`（912 行；1-210 行为 helpers/常量/错误/接口/AsyncMutex/ReservationImpl，211-911 行为 TempManager 类）
- **分类**：结构
- **现状**：文件系统小工具（isInside/isSafeSubdirId/lstatOrNull/readFileOrNull/sleep）、环境变量读取器（getTempTtlMs 等 4 个）、STAGING 常量、2 个错误类、AsyncMutex、4 个公开接口与 ReservationImpl 全部与 700 行 TempManager 类同文件
- **问题**：类型与基础设施层和执行器混装；912 行为第二大文件；ReservationImpl 依赖接口定义与类体分离阅读
- **建议**：拆出 `src/temp-core.ts` 承载上述 helpers/常量/错误/接口/AsyncMutex/ReservationImpl；`temp-manager.ts` 保留 TempManager 类与单例并 re-export temp-core 全部公开符号，外部 import 路径零变化
- **建议映射的方法**：M-L3-07（Single Responsibility Split）
- **风险**：低（tests/unit/temp-manager.test.ts 480 行覆盖公开行为；facade 保证 API 不动）
- **验证**：AI 自证（tests/unit/temp-manager.test.ts + tsc）
- **范围**：约 250 行迁移 / 1 文件新增 1 文件瘦身

### [R4] 裁剪 adaptive.ts DEFAULT_TIMEOUTS 的 9 条死配置 ✓

- **位置**：`src/adaptive.ts:6-17`
- **分类**：可读性
- **现状**：`DEFAULT_TIMEOUTS` 声明 10 个工具的超时默认值，但 `adaptiveTimeout` 全项目仅 `src/tools/command.ts:364` 一个调用点且只传 `"execute_command"`；其余 9 条（batch_execute、watch_command、get_system_info 等）永不可达
- **问题**：9/10 条目为不可达配置，误导维护者以为改表可调其它工具超时
- **建议**：DEFAULT_TIMEOUTS 收缩为仅 `execute_command: 30000` 一条，保留导出与函数签名不变，其余工具超时仍走各自 handler 的显式值
- **建议映射的方法**：M-L3-07（模块职责收缩到实际使用面）
- **风险**：低（两处测试均只测 execute_command 路径）
- **验证**：AI 自证（tests/unit/infra.test.ts adaptive describe + tests/unit/upgrades-r2.test.ts 功能-B describe）
- **范围**：约 10 行 / 1 文件

### [R5] scan.ts 的 isCredentialFilePath 迁移为 security 直引并删弃用再导出 ✓

- **位置**：`src/scan.ts:70-72`、`tests/unit/core.test.ts:285,324-331`
- **分类**：可读性
- **现状**：scan.ts 尾部 `@deprecated` 再导出 `isSensitivePath as isCredentialFilePath`，唯一消费方是 tests/unit/core.test.ts（同时从 scan.js 导入 scanContent 与 isCredentialFilePath）
- **问题**：实现已委托 security.ts 却保留别名再导出，形成双入口；@deprecated 挂了数个版本未清
- **建议**：core.test.ts 改为从 `security.js` 导入 `isSensitivePath`（断言等价改名），删除 scan.ts 的弃用再导出；scan.ts 其余导出（scanContent/分级函数）不动
- **建议映射的方法**：M-L2-04（Move Function——消费方改引唯一实现处）
- **风险**：低（测试同步改，无 src 消费方）
- **验证**：AI 自证（tests/unit/core.test.ts + grep isCredentialFilePath 零残留）
- **范围**：约 10 行 / 2 文件
