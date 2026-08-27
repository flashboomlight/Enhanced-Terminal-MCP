---
doc_type: issue-fix
issue: 2026-07-12-execution-reliability
path: standard
status: resolved
fix_date: 2026-07-12
related: [execution-reliability-analysis.md]
tags: [reliability, session, concurrency, output-truncation, shutdown]
---

# 执行可靠性缺陷 修复记录

## 1. 实际采用方案

四处全部采用 analysis 推荐方案:

- **3.1(session 竞态)**:SessionStore 暴露 `readonly loaded: Promise<void>`,构造函数赋值 `this.loaded = this.loadFromDisk()`;`loadLegacyFile` 改 async 返回 promise(原为 fire-and-forget 同步函数);index.ts `server.connect` 前 `await session.loaded`
- **3.2(scanContent 误报)**:Generic API Key 正则阈值 `{16,}` → `{32,}`;Connection String 正则加 `(?!localhost|127\.0\.0\.1)` 排除本地连接串
- **3.3(截断丢数据)**:stream.ts 超限时截取当前 chunk 到 maxOut 边界入栈(保留部分输出);command.ts truncated 错误 message 带前 500 字 partial stdout
- **3.4(退出窗口)**:index.ts 退出窗口 500ms → 3000ms

## 2. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/session.ts` | 加 `loaded: Promise<void>` 字段;构造函数赋值;`loadFromDisk` 返回 promise;`loadLegacyFile` 改 async |
| `src/index.ts` | `await session.loaded`(connect 前);退出窗口 3000ms |
| `src/scan.ts` | Generic API Key 阈值提至 `{32,}`;Connection String 排除本地 |
| `src/stream.ts` | stdout 超限时截取到 maxOut 边界入栈,保留部分输出 |
| `src/tools/command.ts` | truncated 错误 message 带 partial stdout 前 500 字 |

未触碰 analysis 范围外文件。3.3 故意不改 execute_command outputSchema(规避 AGENTS.md 工具契约红线)。

## 3. 验证结果

### build / lint

- `npx tsc --noEmit` 通过
- `npm run lint` 通过
- `npm run build` 通过

### 单元测试

- **全量 `npm test`:28 文件 / 384 测试全过**(含此前失败的 3 个 session 测试)
- 这是 3.1 修复的关键验证——前两个 issue 跑全量时 session 测试在并发压力下失败 3 个,本次修复后全量并发不再失败

### 复现步骤验证

自建脚本 8 项检查全过:

- ✓ `api_key=1234567890123456`(16 字符)不再误报
- ✓ `api_key=<32 字符>` 仍拦截
- ✓ `mongodb://user:pass@localhost` 不误报
- ✓ `mongodb://user:pass@prod.host` 仍拦截
- ✓ OpenAI sk- 仍拦截
- ✓ 超限触发 truncated
- ✓ 超限保留部分输出(含已收集的 x)
- ✓ 截断标志 ...(TRUNCATED) 存在

3.1(session 竞态)通过全量测试不再失败间接验证;3.4 退出窗口纯常量改,代码检查确认。

## 4. 遗留事项

1. **3.3 截断仍是 isError=true**:方案 A 不改 outputSchema(规避契约红线),截断返回 EXECUTION_FAILED 错误。LLM 需从 error message 的 partial stdout 诊断。若未来要改"截断=success 带 truncated 字段",需走 AGENTS.md 显式授权改 outputSchema——属更正确的语义但超本 issue 范围
2. **3.2 阈值权衡**:Generic API Key 提到 32 字符可能漏拦 16-31 字符的真 key(罕见,主流 API key 均 ≥32)。Connection String 排除 localhost 可能漏拦指向 localhost 的真密钥连接串(开发环境少见)
3. **3.4 退出响应变慢**:3000ms 比 500ms 多 2.5s,用户感知到退出延迟(可接受)
