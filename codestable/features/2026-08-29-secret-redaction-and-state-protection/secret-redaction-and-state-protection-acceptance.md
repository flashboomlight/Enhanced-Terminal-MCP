---
doc_type: feature-acceptance
feature: 2026-08-29-secret-redaction-and-state-protection
requirement:
roadmap: production-hardening
roadmap_item: secret-redaction-and-state-protection
status: done
summary: 对照设计完成统一 secret 治理验收；redactor/env 大小写策略/scan 完备性/出口接线/安全文件模式全部落地，代用户完成三轮反向审计并补齐三处证据缺口，门禁全绿后回写 CodeStable
tags: [production, hardening, secret, redaction, env-policy, session, audit, cache, acceptance]
created: "2026-08-29"
last_reviewed: "2026-08-29"
---

# secret-redaction-and-state-protection 验收

> 验收方式：用户已授权代理代为执行整个 CodeStable 流程（含验收与多轮审计），本报告由代理对照 approved design 逐场景核对后出具。
> 验收日期：2026-08-29
> 对应 design：`secret-redaction-and-state-protection-design.md`；checklist 12 checks 全部 passed。

## 1. 交付对照

| design 交付 | 落地 | 证据 |
|---|---|---|
| `src/secret-governance.ts`（redactor + env policy + `redactError`） | ✅ | redactText/redactCommand/redactDetail/sanitizeLogField/redactError + isDeniedEnvKey/validateEnvKeyPolicy/getEnvValueMode/envValueDisplayAllowed/persistentEnvValueAllowed；运行时仅依赖 secret-registry（result 仅 type import），无模块环 |
| scan 完备性（`complete`/`scannedBytes` + 前缀扫描） | ✅ | 超 4MiB 扫描 UTF-8 前缀且 `complete:false`；不再无条件视为 safe |
| ResultBoundary（fail() 单点） | ✅ | message/suggestion redact+2000 字符截断、detail 走 redactDetail；`toCallToolResult`/成功 envelope 结构不变 |
| 出口接线（logger/audit/context/safeguard/index fatal） | ✅ | logger 三字段经 sanitizeLogField；audit.record 入队前 redact；usage-guide `last_cmd`、risk-gated confirmation 预览/batch 逐条、fatal stderr 全部净化 |
| session 安全持久化 | ✅ | env 默认仅存 `envKeys`；opt-in（`MCP_SESSION_PERSIST_ENV_VALUES=1`）且仅非 denied/非 sensitive value 落盘；history 逐条 redactCommand；`atomicWriteFile`（exclusive staging + POSIX 0o600） |
| env 大小写策略 | ✅ | deny 判定统一 `toUpperCase()`；`path`/`Node_Options`/`ld_preload` 变体在 set_env 与恢复路径均被拒 |
| strict fail-closed | ✅ | write/read 超扫描能力返回 `RESOURCE_LIMIT`；cache tier 超大内容可写但不入缓存 |
| environment_vars 值展示策略 + 移出缓存 | ✅ | `MCP_ENV_VALUE_MODE=allowlist|full|keys`（默认 allowlist）+ `MCP_ENV_VALUE_ALLOWLIST`；sensitive 恒掩码；展示值过 redactor；`CACHEABLE_TOOLS` 移除且单测验证永不命中 |
| 安全文件模式 | ✅ | audit.jsonl append/compact 0o600（compact 改走 atomicWriteFile）；state/logs/temp/session 迁移 staging 目录 0o700、迁移 staging 文件 0o600；Windows 为 no-op（design §4 已声明） |
| secret-stream.ts / secret-registry.ts 零改动 | ✅ | git status 确认两文件不在改动集；pattern 唯一来源未复制 |

## 2. 验收场景核对（design §5 场景 1-10）

1. **env 变体拒绝** ✅ `tests/unit/session.test.ts`（`setEnv rejects denied keys case-insensitively`：path/Node_Options/ld_preload 全拒）+ `tests/unit/tools/utility.test.ts`（deny 大小写不敏感）+ secret-governance 单测（isDeniedEnvKey 变体矩阵）。
2. **keys-only 持久化 + redacted history** ✅ session.test 三用例：默认 `envKeys` 存在且 `env` 字段缺省、value 不还原不注入；opt-in 后仅 `MY_VAR` 落盘（`path` 在 set 阶段即拒、`MY_TOKEN` 永不落盘）；history 含 `ghp_…` 的命令落盘为 `[REDACTED]`。
3. **秘密不进出口** ✅ `tests/unit/audit.test.ts`（record 含 token 的 detail 与带 CRLF 的 error 落盘后无原文、含 `[REDACTED]`、换行为字面转义且 JSONL 行内无真实换行）；logger/last_cmd/confirmation 与 audit 共用 sanitizeLogField/redactText（函数级同源，单测覆盖）。prompt 注入字段（cwd/env key/last_cmd）全部过 sanitizeLogField。
4. **error detail 净化** ✅ secret-governance `ResultBoundary` describe：`commandBlocked`/`timeout` 的 `detail.command` 为 `echo [REDACTED]`，序列化后无原文，非秘密字段（timeout_ms）保留。
5. **logger 控制字符转义 + 限长** ✅ sanitizeLogField 用例：`\r\n`→`\\r\\n`、`\t`→`\\t`、ESC→`\x1b`、5000 字节截断至 1000 内。
6. **strict fail-closed** ✅ files.test：strict 下 5MiB write 与 90k 行 read 均 `RESOURCE_LIMIT`（param 分别为 content/file_path，write 无文件落盘）；default tier 5MiB write 成功落盘（允许决策，不声称 safe）。
7. **environment_vars 三模式** ✅ system.test：PATH（内建白名单）返回值；非白名单默认 `***`；`MCP_ENV_VALUE_ALLOWLIST` 补充项命中；`full` 显示非敏感值；`keys` 全掩码；list 模式下 sensitive 恒 `***`。
8. **缓存准入** ✅ secret-governance cache admission 三用例：超大内容执行但不缓存、可扫描安全内容命中、environment_vars 永不命中（增量断言避免 clear() 不重置计数器的干扰）。
9. **原子落盘与权限** ✅ session.json 经 atomicWriteFile（path-policy 既有单测覆盖 staging 无残留/原子替换）；audit/迁移/temp 的 0o600/0o700 收紧已落地（Windows no-op 由 design 声明，无 Windows 可验证语义）。
10. **兼容与门禁** ✅ 全量 `pnpm run gate` EXIT=0：build/tsc/lint 0、全量 54 文件 709 用例、latency 24/24、tools coverage 60.76/49.56/65.97/64.6（阈值 55/45/60/55）；`git diff --check` 通过；既有 676 用例中仅 3 处按 design 预告更新（session env roundtrip ×1、system env 展示 ×2）。

## 3. 代用户三轮反向审计记录

- **轮 1（泄漏面横向扫描）**：确认 secret-governance 之外无未接 redactor 的出口（health/audit 资源/telemetry 均只含 keys、错误码与计数）；发现 3 个验收场景缺直接测试证据（audit 落盘、error detail、environment_vars 不缓存）→ 补 4 个用例后闭环。
- **轮 2（反向检查清单）**：pattern 唯一来源、入队前净化、FORBIDDEN_ENV_KEYS 成员不变（仅大小写规范化）、流式主路径零二次扫描、`MCP_ENV_VALUE_MODE` 非法值回落 allowlist 并由消费方告警——全部有代码 diff 或单测对应。
- **轮 3（断言与对抗复查）**：测试自身暴露两处问题并修正——`toolCache.clear()` 不重置命中计数器（改增量断言）；JSON 落盘层对字面反斜杠再转义（断言改在解析后的 entry 上）。执行链红线复核：本 feature 未触碰 `command.ts` 执行路径，全量 e2e 真实命令通过证明 spawn/env 注入原文不变。
- 终轮无新问题，审计停止。

## 4. 行为收紧记录（预期内，非回归）

- `session_state set_env` 对 denied key（含小写变体）从"可注入"变"拒绝"。
- `environment_vars` 非白名单 key 从"显示值"变"***"，且结果不再进入共享缓存。
- `MCP_SECRETS_SCAN=strict` 下超过 4MiB 的读/写从"跳过扫描放行"变"RESOURCE_LIMIT"。
- 默认 tier 超大内容从"可入缓存"变"不入缓存"。
- session.json 不再保存 env value 与原始命令（opt-in 仅对 env value 开放）。

## 5. 归属与遗留

- audit writer 轮换/重试/durable spool、session revision writer、锁 fencing → `audit-health-and-state-writer`（本 feature 未触碰）。
- capability/profile 对 `process_list`/`get_system_info`/`network_info` 的准入矩阵 → `tool-wrapper-and-surface-contract`。
- 既有 audit.jsonl/session.json 历史原文不做追溯清洗（design §1 明确不做）；清理/轮换归 #8。
- 命令输出流式路径（secret-stream 状态机、quarantine fail-closed、capture 限流丢弃不构成泄露面）维持 M2 验收结论，未改动。

## 6. 结论

SEC-04/SEC-05 的本 feature 范围内交付全部落地并通过门禁；roadmap 第 6 条标记 `done`，解锁 `audit-health-and-state-writer`（依赖 #6 + #2 均已 done）。
