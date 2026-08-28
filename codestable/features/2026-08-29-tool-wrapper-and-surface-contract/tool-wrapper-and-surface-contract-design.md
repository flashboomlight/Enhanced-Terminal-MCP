---
doc_type: feature-design
feature: 2026-08-29-tool-wrapper-and-surface-contract
requirement:
roadmap: production-hardening
roadmap_item: tool-wrapper-and-surface-contract
status: approved
summary: 建立 ToolRegistry 真实启用计数（§5.7 契约）、wrapHandler 未预期异常/取消边界、响应字节兜底、action-dependent schema 收紧、capability 矩阵接线与 health/prompt/tools/list 27/26 一致性
tags: [production, hardening, tool-contract, wrapHandler, registry, capability, schema, response-budget]
created: "2026-08-29"
last_reviewed: "2026-08-29"
depends_on: [2026-08-28-hardening-contract-and-profiles]
---

# tool-wrapper-and-surface-contract 设计

## 1. 背景与目标

生产硬化 roadmap 第 9 条（模块 H · tool-contract）。生产就绪审计中本条负责关闭：

- **REL-05（P1）**：`wrapHandler` 没有 catch；handler 未预期 throw 时直接得到 rejected promise，而不是 `INTERNAL_ERROR` + telemetry + 统一 MCP 结果。
- **PRO-01（P2）**：`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 只 disable 了 SDK tool handle，`wrapHandler` 的计数已先自增；banner、health、prompt 仍报 27，真实 `tools/list` 是 26。
- **PRO-02（P2）**：`pool_stats` 是诚实标记的 inactive stub，但需要测试固化 `active:false` 与文案一致的证据。
- **SEC-06（P1）**：host-disclosure/capability 矩阵缺口中属于本条的部分——把 `CapabilityPolicy` 真正接线到披露面工具。

契约硬约束：roadmap §5.0（`(args, extra)` 适配必须集中、不得从 arguments 接收身份/取消）、§5.7（ToolRegistry：`register` / `activeCount` / `activeNames`，tool count 必须来自最终启用的 registry）、§5.9（未知异常统一映射 `INTERNAL_ERROR`，`Error.message` 原样不是稳定 API）。

验收基线（§6.9）：handler throw 返回 `INTERNAL_ERROR`；默认工具数 27、禁用 file_info 时 26；两种配置下 health/prompt/tools/list 一致；缺少 action 所需字段不会静默 no-op；异常/响应不泄露原始 detail。

## 2. 现状与差距（证据）

| # | 现状 | 证据 | 差距 |
|---|---|---|---|
| 1 | `wrapHandler` 无 try/catch | `src/wrap.ts:60` 直接 `await fn(args, context)` | REL-05：throw 变 rejected promise |
| 2 | 计数在 wrap 时自增、与 enable 状态无关 | `src/wrap.ts:14-17` `_registeredToolCount++`；`src/tools/files.ts:399-401` 之后才 `disable()` | PRO-01：27/26 不一致 |
| 3 | `session_state` 缺参静默 no-op | `src/tools/utility.ts:268` `action === "set_cwd" && cwd`——无 cwd 直接跳过并返回快照 `changed:false`；set_env 同型（:311） | 验收红线 |
| 4 | `environment_vars` get 缺 name 静默变 list | `src/tools/system.ts:283` `action === "get" && name` 否则走 list 分支 | 验收红线 |
| 5 | `network_info` ping/dns 缺 target 隐式打 127.0.0.1/localhost | `src/platform.ts:100` 默认值；`src/tools/system.ts:235` 仅当 target 存在才做 validateHost/egress 校验 → 默认路径绕过 egress 校验 | 验收红线 + egress 不一致 |
| 6 | 无响应字节兜底 | `src/result.ts:407` `toCallToolResult` 无限长校验；命令类工具只有自身 stdout 预算 | PRO/REL 响应预算缺口 |
| 7 | `CapabilityPolicy` 已实现但零消费点 | `src/profile.ts:133-148` `createCapabilityPolicy` 无调用方 | SEC-06 capability 矩阵未接线 |
| 8 | health resource 无工具数字段 | `src/tools/utility.ts:434-471`；usage-guide/safety-info/banner 读的是差距 2 的错计数 | 27/26 一致性无落点 |
| 9 | SDK `RequestHandlerExtra` 确认含 `signal`/`requestId`/`sessionId?`/`authInfo?`/`_meta` | `sdk/shared/protocol.d.ts:173-` | `RequestHandlerExtraLike` 子集适配已成立，需测试固化 |
| 10 | SDK 1.29 `normalizeObjectSchema` 对 v3 `ZodEffects`（`refine`/`superRefine`/union 产物）返回 `undefined`，`tools/list` 广告空 schema | `sdk/server/zod-compat.js:79-133`（v3 只认 `.shape`）+ `mcp.js:75-77`（回落 `EMPTY_OBJECT_JSON_SCHEMA`） | schema 层 refine/discriminated union 被 SDK 1.29 阻断，action 收紧必须放 handler 层 |

`tests/tool-visibility.test.ts` 已存在 27/26 的 `tools/list` 断言（子进程 e2e），是本条一致性测试的扩展载体。

## 2.5 结构健康度

- 新增 `src/tool-registry.ts`（预计 <80 行，单一职责：工具注册记账 + 启用计数），`src/wrap.ts` 删除计数职责后回到纯 telemetry + 缓存 + 边界（~110 行），不产生大文件继续加职责。
- 工具文件改动为 `server.registerTool(` → `registerManagedTool(server, ` 的机械替换（27 处，参数顺序不变），无业务逻辑改动。
- action 收紧只在 3 个工具的 handler 首行显式拒绝（schema 保留 optional 并以 `.describe()` 标注条件必填），函数体不增长一屏。
- 不新增万能工具类；`capabilityGate` 放 `src/profile.ts`（capability 语义既有归属），8 行内。

## 3. 方案设计

### 3.1 ToolRegistry 真实启用计数（关闭 PRO-01，落实 §5.7）

新文件 `src/tool-registry.ts`：

```ts
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

const registry = new Map<string, RegisteredTool>();

/** 注册工具并记账；单一真源是 SDK RegisteredTool.enabled 标志，不维护镜像状态 */
export function registerManagedTool(server: McpServer, name, config, handler): RegisteredTool;
/** 当前启用（enabled === true）的工具数 —— banner/health/prompt 的唯一计数来源 */
export function getRegisteredToolCount(): number;
/** 当前启用工具名（只读数组） */
export function getEnabledToolNames(): readonly string[];
/** 全部已注册（含禁用）工具名，测试诊断用 */
export function getAllRegisteredToolNames(): readonly string[];
```

- `getRegisteredToolCount()` 语义从"包装过多少个 handler"改为"最终启用的注册表条目数"；`files.ts` 的 `fileInfoTool.disable()` 直接反映到计数，无需同步代码。
- 与 roadmap §5.7 `ToolRegistry` 契约的映射：`getRegisteredToolCount()` ≡ `activeCount()`、`getEnabledToolNames()` ≡ `activeNames()`、`registerManagedTool` ≡ `register`（保留项目既有命名约定——AGENTS.md 要求工具数经 `getRegisteredToolCount()` 动态获取，不引入第二套命名）。
- `src/wrap.ts` 删除 `_registeredToolCount`；`src/index.ts`（banner）与 `src/tools/utility.ts`（usage-guide/safety-info）的 import 改为 `./tool-registry.js` / `../tool-registry.js`。`getRegisteredToolCount` 名称保留（AGENTS.md 约定动态获取、勿硬编码）。
- 注册即记账：27 处工具文件调用点机械替换；`registerManagedTool` 内部仍调用 `server.registerTool`，SDK 行为（listTools 过滤 disabled、disable 时 sendToolListChanged）不变。

### 3.2 wrapHandler 异常/取消边界（关闭 REL-05）

`src/wrap.ts` 执行段改为：

```ts
let result: ToolResult;
try {
  result = await fn(args, context);
} catch (e: unknown) {
  const cancelled = context.signal.aborted || (e instanceof Error && e.name === "AbortError");
  logger.warn("wrap", "unexpected-handler-error", cancelled ? "aborted" : "unhandled", toolName);
  telemetry.record({ toolName, latency_ms: Date.now() - t0, ok: false, errorCode: cancelled ? "CANCELLED" : "INTERNAL_ERROR", cacheHit: false, timestamp: Date.now() });
  return toCallToolResult(cancelled ? Errors.cancelled(`Tool call cancelled: ${toolName}`) : Errors.internalError(redactError(e).message));
}
```

- 未预期异常统一 `INTERNAL_ERROR`（§5.9）；message 经 `redactError`（secret-governance）净化，不泄露原始 detail/命令/凭据。
- cancellation 边界：`context.signal.aborted` 或 `AbortError` → `CANCELLED`（retryable），与 supervisor 的取消语义一致。
- 错误路径不写缓存（现有逻辑只缓存 `result.ok`，catch 提前 return 天然满足）；telemetry 与成功路径同一记录面。
- 直调 fallback（`directCallExtra`）语义不变，测试固化。

### 3.3 结构化响应字节契约

- 新配置 `MCP_RESPONSE_MAX_BYTES`：默认 `2097152`（2 MiB）；用 `parseStrictInteger` 严格解析，缺失/非法/≤0 → 回落默认 + `logger.warn`（与 #7 `getSsrfMode` 的配置回落模式一致）。进程内只解析一次。
- `wrapHandler` 在 `toCallToolResult` 前度量：`Buffer.byteLength(result.content, "utf8") + (result.structured !== undefined ? Buffer.byteLength(JSON.stringify(result.structured), "utf8") : 0)`；`JSON.stringify` 抛错（理论不可达，structured 均为内部 JSON-safe 字面量）按 `INTERNAL_ERROR` 处理。
- 超限 → `Errors.resourceLimit("Tool response exceeds budget", { tool, bytes, limit })`（detail 仅有限元）→ 走既有错误转换；`withErrorSchema` 全 optional，错误 envelope schema 合法，`isError` 语义不变。
- 命令类工具已有更紧的独立输出预算（stdout/retained bytes + paging），本兜底只拦"意外无界出口"，不与之冲突。

### 3.4 action-dependent schema 收紧（关闭静默 no-op）

**机制决定：handler 层显式拒绝**。schema 层 `refine`/`superRefine`/discriminated union 在 SDK 1.29 下不可用——`normalizeObjectSchema` 对 v3 `ZodEffects`/union 返回 `undefined`，`tools/list` 会把这些工具的 inputSchema 广告成空对象（差距 10 证据），属于比静默 no-op 更糟的 surface 回归。SDK 1.29 为 outputSchema patch 锁定，升级不在本条范围。handler 层拒绝发生在任何 spawn/读盘/递归之前，满足 §5.3 的意图；schema 字段保留 optional，并在 `.describe()` 中标注"action 为 X 时必填"。

三个带 action 参数的工具：

| 工具 | 规则 | handler 行为 |
|---|---|---|
| `session_state` | `set_cwd` ⇒ `cwd` 非空必填；`set_env` ⇒ `key` 非空必填且 `value` 必须出现（允许空串，保持现有语义） | 缺参 → `fail(VALIDATION_ERROR, ...)`，param 指向缺失字段 |
| `environment_vars` | `get` ⇒ `name` 非空必填 | 缺 name → `VALIDATION_ERROR`（不再静默降级为 list） |
| `network_info` | `ping`/`dns` ⇒ `target` 必填 | 缺 target → `VALIDATION_ERROR`；删除隐式 127.0.0.1/localhost 默认（消除默认路径绕过 egress 校验的不一致） |

- MCP 路径的结果是 `isError: true` + 结构化错误 envelope（带 suggestion），比 JSON-RPC `INVALID_PARAMS` 更可诊断，且直调与 MCP 双路径同源。
- handler 内原 `&& cwd` / `&& name` 守卫改写为显式缺参拒绝，不保留静默跳过分支。
- 该 SDK 约束同步记入 design 发现：后续 feature 若需要 discriminated union 入参，必须先升级 SDK 并连 patch 一起验证。

### 3.5 capability 矩阵接线（关闭 SEC-06 本范围）

`src/profile.ts` 新增：

```ts
/** 返回 null 表示放行；否则返回 CAPABILITY_DENIED ToolError（detail 含 capability） */
export function capabilityGate(context: RequestContext, capability: Capability): ToolResult | null;
```

- 内部用 `createCapabilityPolicy()` 默认单例：`local-trusted-shell` 全放行（零行为变化）；`sandboxed-production` 未声明 → `Errors.capabilityDenied`。
- 接线 5 个披露面（与 roadmap §3.3 矩阵行对应）：

| 工具 | capability |
|---|---|
| `process_list` | `host-process-inspection` |
| `get_system_info` | `host-process-inspection` |
| `network_info` | `network-egress` |
| `download_file` | `network-egress` |
| `environment_vars` | `host-environment-read` |

- gate 放在各 handler 首行（任何 spawn/读盘之前）；相应 5 个 handler 显式声明 `context: RequestContext` 形参（wrapHandler 已注入该参数，无新契约）。`kill_process` 已有身份证明链、文件工具宿主边界声明不动，本条不扩（见 §7）。
- 当前 `sandboxed-production` 因 `assertProfileAvailable` 默认不可用而无法启动，此 gate 属"契约先行"；端到端 sandbox 拒绝 e2e 归 #12 conformance gate。

### 3.6 surface 一致性（27/26 三面同源）

- health resource（`health://status`）JSON 增加 `"tools": { "enabled": <启用数>, "disabled": <注册但禁用数> }`（命名明确区分 enabled/disabled，`registered` 一词弃用以避免歧义）。
- usage-guide prompt 文本、safety-info prompt `tools` 字段、server banner 读同一 `getRegisteredToolCount()`（改造后即启用数）。
- e2e 扩展 `tests/tool-visibility.test.ts`：两种配置（默认 / `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`）下各 spawn 一次 server（同一连接内取全），同时断言：
  1. `tools/list` 长度 = 27 / 26；
  2. `prompts/get usage-guide` 文本含精确子串 `provides 27 tools` / `provides 26 tools`；
  3. `resources/read health://status` 的 `tools.enabled` 等于对应数字（默认配置下 `disabled=0`，禁用配置下 `disabled=1`）；
  4. `tools/call pool_stats` 的 `active === false`（PRO-02 证据固化）；
  5. `tools/call session_state {"action":"set_cwd"}`（缺 cwd）→ `isError === true` 且 `error.code === "VALIDATION_ERROR"`（MCP 全链路"不静默 no-op"证据）。

## 4. 配置表

| 环境变量 | 默认 | 语义 |
|---|---|---|
| `MCP_RESPONSE_MAX_BYTES` | `2097152` | 工具响应（content + structuredContent 的 UTF-8 序列化字节）兜底上限；缺失/非法/≤0 回落默认并 warn；不提供"无限制"取值。落点：README 环境变量节 + CHANGELOG + 三个 action 工具的 `.describe()` 同步更新 |

## 5. 行为变化表

| # | 场景 | 变更前 | 变更后 |
|---|---|---|---|
| 1 | handler 未预期 throw | rejected promise（MCP 侧 transport error） | `INTERNAL_ERROR` ToolResult（净化 message + telemetry） |
| 2 | 执行中 signal abort / AbortError 逃逸 | 同上（error 文本不定） | `CANCELLED`（retryable） |
| 3 | `session_state set_cwd` 缺 cwd | 静默返回快照 `changed:false` | `VALIDATION_ERROR`（param=cwd） |
| 4 | `session_state set_env` 缺 key/value | 静默返回快照 | `VALIDATION_ERROR`（param=key/value） |
| 5 | `environment_vars get` 缺 name | 静默返回全量 list | `VALIDATION_ERROR`（param=name） |
| 6 | `network_info ping/dns` 缺 target | 隐式 ping 127.0.0.1 / nslookup localhost（且跳过 egress 校验） | `VALIDATION_ERROR`（param=target） |
| 7 | `DISABLE_FILE_INFO=1` 下 banner/health/prompt | 恒 27 | 26（与 tools/list 一致） |
| 8 | 成功响应 > 2 MiB | 原样返回 | `RESOURCE_LIMIT` 错误 envelope（detail 含 tool/bytes/limit） |
| 9 | sandboxed profile 披露面 | 无 gate（profile 不可达） | `CAPABILITY_DENIED`（契约先行） |

行为 3-6 为对外可见的收紧，将写入 CHANGELOG 与 README 工具描述。

## 6. 测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| unit | `tests/unit/wrap.test.ts`（扩展） | throw→INTERNAL_ERROR 且 message 脱敏（throw 带凭据文本）、aborted→CANCELLED、超限→RESOURCE_LIMIT、错误不缓存、直调 fallback、`(args, extra)` 适配固化（extra.requestId→context.requestId、sessionId→scopeId、signal 透传、伪造 arguments 无法覆盖）、telemetry 记录、响应字节口径 |
| unit | `tests/unit/tool-registry.test.ts`（新增） | register 记账、disable/enable 联动计数、activeNames/getAllRegisteredToolNames、fake McpServer |
| unit | `tests/unit/profile.extended.test.ts`（扩展） | capabilityGate：local 放行 / sandbox 未声明拒绝 / sandbox 声明后放行 |
| unit/tools | `tests/unit/tools/utility.test.ts`、`tests/unit/tools/system.test.ts`（扩展） | 三工具 action 缺参显式拒绝（直调路径，逐字段 param 断言） |
| e2e | `tests/tool-visibility.test.ts`（扩展） | 两种配置下 tools/list 27/26、usage-guide `provides N tools` 子串、health `tools.enabled/disabled`、pool_stats.active=false、session_state 缺 cwd 的 MCP 全链路 VALIDATION_ERROR |
| gate | `pnpm run gate` | build + tsc + lint + test + latency + tools coverage |

## 7. 明确不做

- 不实现 sandboxed-production 的 availability 声明/argv backend（另属后续 conformance/backend feature）；本条只落 capability gate 契约与单测。
- 不激活或删除 `ProcessPool`（PRO-02 维持诚实 inactive stub + 测试固化；激活属独立性能决策）。
- 不改 SDK、不 fork `registerTool` 协议；不新增 transport/身份能力。
- 不做逐工具 outputSchema 全量上限收紧（各工具既有输入/遍历预算 + 本条响应兜底共同覆盖；逐工具 schema 属后续 feature 若审计再要求）。
- 不给 `kill_process`/文件工具加 capability gate（前者已有身份证明链，后者宿主 sandbox 为强边界；SEC-06 剩余部分随 backend feature 收口）。
- 不改变任何工具名、业务语义与错误码既有映射。

## 8. 验收标准映射（roadmap §6.9）

| 验收句 | 落点 |
|---|---|
| handler throw 返回 `INTERNAL_ERROR` | §3.2 + wrap 单测 |
| 默认工具数 27、禁用 file_info 时 26 | §3.1 + tool-registry 单测 + e2e |
| 两种配置下 health/prompt/tools/list 一致 | §3.6 e2e 四断言 |
| 缺少 action 所需字段不会静默 no-op | §3.4 + tools 层单测 + e2e 第 5 条（MCP 全链路） |
| 异常/响应不会泄露原始 detail | §3.2 redactError、§3.3 detail 有限元 + 脱敏单测 |

## 9. 风险与缓解

- **27 处机械替换漏改**：实现后 `grep -rn "server.registerTool(" src/tools/` 必须零残留（utility 的 `server.resource`/`server.prompt` 不在替换范围）。
- **e2e 时长**：复用 `tool-visibility.test.ts` 既有两个 spawn 进程扩展断言，不新增进程对。
- **响应度量与缓存互斥**：超限错误不缓存（只缓存 ok），无脏缓存风险。
- **capability 单例与 profile 冻结次序**：`capabilityGate` 惰性取 `getActiveExecutionProfile()`，与 wrapHandler 的 context 构造同源，无初始化次序新依赖。
