---
doc_type: feature-acceptance
feature: 2026-08-29-tool-wrapper-and-surface-contract
requirement:
roadmap: production-hardening
roadmap_item: tool-wrapper-and-surface-contract
status: done
summary: 对照设计完成 tool-contract 验收；真实启用工具计数（27/26 三面同源）、wrapHandler 异常/取消边界、MCP_RESPONSE_MAX_BYTES 响应兜底、三个 action 工具缺参显式拒绝与 capability 五披露面接线全部落地，三轮反向审计发现并规避 SDK 1.29 ZodEffects schema 限制，门禁全绿后回写 CodeStable
tags: [production, hardening, tool-contract, wrapHandler, registry, capability, schema, response-budget, acceptance]
created: "2026-08-29"
last_reviewed: "2026-08-29"
---

# tool-wrapper-and-surface-contract 验收

> 验收方式：用户已授权代理代为执行整个 CodeStable 流程（含验收与多轮审计），本报告由代理对照 approved design 逐场景核对后出具。
> 验收日期：2026-08-29
> 对应 design：`tool-wrapper-and-surface-contract-design.md`；checklist 11 checks 全部 passed。

## 1. 交付对照

| design 交付 | 落地 | 证据 |
|---|---|---|
| `src/tool-registry.ts` 真实启用计数（PRO-01 / §5.7） | ✅ | `registerManagedTool` 记账 name→RegisteredTool；`getRegisteredToolCount()`/`getEnabledToolNames()` 读 SDK 句柄 `enabled` 标志，disable/enable 即时反映；§5.7 映射：getRegisteredToolCount≡activeCount、getEnabledToolNames≡activeNames |
| 27 处注册点机械替换 | ✅ | `grep "server.registerTool(" src/` 仅剩 tool-registry.ts 内的委托调用，工具文件零残留 |
| wrapHandler 异常/取消边界（REL-05） | ✅ | try/catch 收敛 rejected promise；`signal.aborted`/`AbortError`→`CANCELLED`；其余经 `redactError`（sanitizeLogField：控制字符转义+redactText+限长）→`INTERNAL_ERROR`；telemetry 记录；错误不入缓存 |
| 响应字节兜底 | ✅ | `MCP_RESPONSE_MAX_BYTES`（默认 2097152，parseStrictInteger，非法/≤0 回落+warn，无无限取值）；content+structuredContent UTF-8 序列化度量；超限→`RESOURCE_LIMIT`（detail 仅 tool/bytes/limit）；序列化失败→`INTERNAL_ERROR` |
| action 缺参显式拒绝 | ✅ | session_state（set_cwd⇒cwd、set_env⇒key/value，value 允许空串）、environment_vars（get⇒name）、network_info（ping/dns⇒target，删除隐式 127.0.0.1/localhost 默认）；handler 首行 `VALIDATION_ERROR` + param 指向缺失字段；schema `.describe()` 标注条件必填 |
| capability 矩阵接线（SEC-06 本范围） | ✅ | `profile.ts capabilityGate`（local 全放行、sandboxed 未声明→`CAPABILITY_DENIED`）；process_list/get_system_info（host-process-inspection）、network_info/download_file（network-egress）、environment_vars（host-environment-read）五面 handler 首行接入 |
| surface 一致性（27/26） | ✅ | health://status 增加 `tools:{enabled,disabled}`；banner/usage-guide/safety-info 同源 `getRegisteredToolCount()`；e2e 双配置四断言全过 |
| PRO-02 pool_stats | ✅ | 诚实 stub 保持；e2e 断言 `active===false` 固化证据 |
| 安全核心零改动 | ✅ | security.ts/safeguard.ts/hardBlock 零触碰；错误码既有映射不变 |

## 2. 验收场景核对（roadmap §6.9 验收句 + design 行为变化表）

1. **handler throw 返回 INTERNAL_ERROR** ✅ `tests/unit/wrap-boundary.test.ts`：throw 带 `ghp_` 假 token → `isError:true`、`error.code=INTERNAL_ERROR`、content 与 error.message 均不含 token；MCP 路径与直调共用同一 wrapper 代码（session_state 缺参 e2e 证明 MCP 路径可达 handler）。
2. **取消映射** ✅ 预先 abort 的 signal + handler throw → `CANCELLED`；未 abort 但 throw `AbortError` → `CANCELLED`。
3. **27/26 计数** ✅ `tests/unit/tool-registry.test.ts`（disable 即时减计数）+ `tests/tool-visibility.test.ts` e2e：tools/list 27/26，server banner 日志同步输出 `27 tools`/`26 tools`。
4. **三面一致** ✅ e2e：usage-guide 文本含精确子串 `provides 27 tools`/`provides 26 tools`；health `tools` 字段 `{enabled:27,disabled:0}`/`{enabled:26,disabled:1}`。
5. **缺参不静默 no-op** ✅ 直调单测：session_state 缺 cwd→param=cwd、set_env 缺 key→param=key、缺 value→param=value（均 `VALIDATION_ERROR`）；environment_vars get 缺 name→param=name；network_info ping 缺 target→param=target（拒绝发生在 spawn 前）；e2e MCP 全链路 `session_state {action:"set_cwd"}` → `isError:true` + `VALIDATION_ERROR`。
6. **响应超限** ✅ `MCP_RESPONSE_MAX_BYTES=10` + 150 字节响应 → `RESOURCE_LIMIT`、`detail.limit=10`；`not-a-number` 回落默认后小响应正常成功。
7. **(args, extra) 适配固化（§5.0）** ✅ extra.requestId→context.requestId，args 内伪造 `requestId` 不可覆盖；direct-call fallback 语义保持。
8. **capability 矩阵** ✅ `tests/unit/hardening-contract.test.ts`：local profile gate 返回 null；sandboxed 未声明→`CAPABILITY_DENIED`（detail 含 capability）；宿主声明后放行由既有 policy 测试覆盖。端到端 sandbox 拒绝归 #12（sandboxed profile 依赖 backend 声明，当前 fail-closed 不可启动）。
9. **PRO-02** ✅ e2e `pool_stats.active===false` 与文案一致。

## 3. 三轮反向审计记录

- **第 1 轮（契约对照）**：修正 4 处——§5.7 契约命名映射说明、health 字段从 `registered` 改为 `enabled/disabled`（消除 27/26 歧义）、prompt 断言精确子串、README 配置落点显式化。
- **第 2 轮（场景对抗）**：发现真实阻断——SDK 1.29 `normalizeObjectSchema` 对 v3 `ZodEffects`（refine/superRefine/union）返回 `undefined`，`tools/list` 会把 inputSchema 广告成空 schema（`zod-compat.js:79-133`+`mcp.js:75-77`）；据此把 action 收紧从"schema refine + handler 双道"改为 **handler 层显式拒绝**，并将该 SDK 约束记入 design 与 items.yaml（升级 SDK 需连 patch 一起验证，属后续 feature）。
- **第 3 轮（全量终审）**：实现后横向取证——注册点零残留（唯一 `server.registerTool` 为 tool-registry 委托）、计数引用全部改属 tool-registry、redactError 脱敏链确认（控制字符转义+redactText+2000 限长）；顺手清理 #7 遗留 3 处 warning（network-policy 未用解构/useOptionalChain、system.ts 未用 import），lint 回零错误。

## 4. 行为收紧清单（对外可见）

| 场景 | 变更前 | 变更后 |
|---|---|---|
| handler 未预期 throw | rejected promise | `INTERNAL_ERROR`（净化 + telemetry） |
| 取消逃逸 | 不定 | `CANCELLED` |
| session_state set_cwd/set_env 缺参 | 静默返回快照 `changed:false` | `VALIDATION_ERROR` |
| environment_vars get 缺 name | 静默降级为全量 list | `VALIDATION_ERROR` |
| network_info ping/dns 缺 target | 隐式 127.0.0.1/localhost（绕过校验） | `VALIDATION_ERROR` |
| `DISABLE_FILE_INFO=1` 下 banner/health/prompt | 恒 27 | 26（与 tools/list 一致） |
| 成功响应 >2 MiB | 原样返回 | `RESOURCE_LIMIT` envelope |

## 5. 门禁证据

- `pnpm run gate` EXIT=0：build ✓、`tsc --noEmit` ✓、biome 0 错误 ✓、全量 **58 文件 752 用例**全过、latency **24/24**、tools coverage **59.41/49.52/67/63.31**（阈值 55/45/60/55）。
- `git diff --check` PASS；TEMP/TMP 重定向 `.etmcp/test-tmp`，无 C 盘写入。
- 新增/更新测试：`tests/unit/tool-registry.test.ts`（新 3 例）、`tests/unit/wrap-boundary.test.ts`（新 7 例）、`tests/unit/hardening-contract.test.ts`（+capabilityGate）、`tests/unit/tools/system.test.ts`（+2）、`tests/unit/tools/utility.test.ts`（+3）、`tests/tool-visibility.test.ts`（重构为 2 配置×5 断言）。

## 6. 遗留与归属

- sandboxed-production 端到端 capability 拒绝 e2e、host capability 声明机制 → 归 `security-and-mcp-conformance-gates`（#12）/ 未来 backend feature。
- SDK 1.29 schema 层 refine/union 限制 → 升级 SDK 属独立 feature（须连 outputSchema patch 一起验证）。
- usage-guide "NEW in v3.1" 等文档过期文案 → 归 `docs-and-architecture-closeout`（#13）。
