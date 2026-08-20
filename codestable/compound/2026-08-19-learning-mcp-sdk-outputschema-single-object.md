---
doc_type: learning
track: pitfall
date: 2026-08-19
slug: mcp-sdk-outputschema-single-object
component: src/result.ts(工具响应协议层)
severity: high
tags: [mcp-sdk, outputschema, zod, structuredcontent, sdk-upgrade]
---

# MCP SDK 1.29:outputSchema 必须能 normalize 成单一 object schema

## 1. 问题

`@modelcontextprotocol/sdk` 升级到 1.29 后给全部 27 个工具注册 outputSchema。直觉做法是给每个工具注册 `z.union([successSchema, errorSchema])`,让成功 / 失败两种响应都有结构。结果注册期一切正常,真实调用才崩。

## 2. 症状

- 服务端 registerTool 不报错,`tools/list` 返回的 schema 看起来正常;
- 客户端真实 callTool 时,SDK 在 schema 序列化路径访问内部 `._zod` 属性失败,**只在调用期暴露**,list 阶段完全不报;
- 即使绕开 union,`isError: true` 的响应若携带与 outputSchema 不匹配的 structuredContent,也会被客户端严格校验拒绝——错误路径同样在校验范围内。

## 3. 没用的做法

- `z.union([successSchema, errorSchema])`:注册能过,调用期崩;
- 把 success schema 直接 `.partial()` 当错误 schema 用:缺少 `ok` / `error` 判别字段,且错误响应不带业务字段时校验照样失败;
- 错误路径干脆不带 structuredContent:与已声明 outputSchema 的工具不兼容,客户端校验失败。

## 4. 解法

保证注册的 outputSchema 始终是**单一 object schema**:

- 成功侧:strict object(`successSchema`,含 `ok: z.literal(true)` 与业务字段);
- 错误侧:由成功侧派生 `successSchema.partial().extend({ ok: z.literal(false), error: structuredErrorSchema })`——`.partial()` 保持 object 形态,`.extend()` 补上判别字段与结构化错误;
- 统一经 `withErrorSchema()`(`src/result.ts`)包裹后再注册,27 个工具注册处不改形态;
- `toCallToolResult` 错误路径返回 `{ ok: false, error: { code, message, detail? } }`,与派生 schema 严格对齐。

## 5. 为什么有效

SDK 1.29 的 outputSchema 走 zod v4 的 JSON Schema 转换路径,只接受能归一成单个 object 的 schema;union 的内部表示在该路径上不被支持,于是调用期崩。`.partial().extend()` 的产物仍是单一 object schema,同时让成功 / 失败响应共享同一字段集,客户端对两侧的 structuredContent 都能校验通过。

## 6. 预防

- SDK 大版本升级后,验证不能停在 `tools/list`——必须至少跑一条真实 callTool 链路(本项目 `tests/e2e-latency.test.ts` 覆盖全部工具的 `/call`,这类问题只有这里能兜住);
- 给工具设计 outputSchema 时先问"它能 normalize 成单一 object 吗",union / discriminatedUnion 默认排除;
- 错误路径的 structuredContent 与成功路径同等对待,schema 设计一开始就把 error 分支包进去,不要后补。

出处:features/2026-08-19-merge-e-hardening-base(M1 merge 期间实测)。
