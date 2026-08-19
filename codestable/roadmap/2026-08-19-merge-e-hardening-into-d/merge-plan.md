# 合并计划：E 盘开发版安全加固合入 D 盘生产版

- 状态：草稿（待审核）
- 日期：2026-08-19
- 作者：flash

## 1. 背景与目标

同一项目存在两条已分叉的开发线：

| 仓库 | 角色 | HEAD |
| --- | --- | --- |
| `E:\MCP 开发\Enhanced Terminal MCP` | 开发版 | `e28f2e9`（2026-07-12） |
| `D:\ALL MCP\Enhanced Terminal MCP` | 生产版 | `a8be122`（2026-08-16，另有后续 `c79c759`） |

共同基线：`d430224`（2026-05-23，v3.1.0 + lint 修复）。之后：

- D 线：+1 提交（Windows 默认 shell 切换为 pwsh7，便携版 pwsh 7.6.5 位于 `tools/pwsh/`，git 忽略），另有一次 file_info 开关提交（`c79c759`）。
- E 线：+24 提交（安全加固：hardBlock 收紧、命令策略 allow 白名单、审计日志、限流、分页、临时资源管理、es.exe 完整性校验、测试迁移 tests/unit 等）。

**最终目标**：以 D 盘为唯一生产主线，保留 D 的 pwsh7 默认 shell，同时吸收 E 盘全部安全加固。E 盘在合并验收后转为备份。

## 2. 合并策略

1. 在 D 盘建立备份分支：`backup/pre-merge`（指向当前 main）。
2. `git fetch "E:\MCP 开发\Enhanced Terminal MCP" main`，得到本地引用（如 `dev-e`）。
3. `git merge --no-ff dev-e`（不使用 rebase：生产库保留双方历史，冲突只解一次）。
4. 按第 3 节规则解决冲突，提交合并。
5. 执行第 4 节验证清单。
6. 验收通过后：E 盘改名备份；D 盘配置远程仓库。

回滚：若合并或验证失败，`git reset --hard backup/pre-merge` 即可完全恢复，E 盘不受任何影响。

## 3. 冲突解决规则

预演结果：约 20 个文件冲突、31 个冲突块（已在临时 clone 中实测）。

总原则：

- **shell 选择以 D 为准**：保留 `shell.ts`、`getShellSpec()`、`buildShellInvocation()`，Windows 默认 pwsh7；E 的 `getShell`/`wrapCommand` 仅作为兼容层保留在 `shell.ts` 中。
- **安全以 E 为准**：`hardBlock`、`command-policy`（blocklist/allow）、`audit`、`ratelimit`、`paging`、`temp-manager`、`es-integrity` 全部保留。
- **安全正则取并集**：D 新增的 PowerShell 注入防护 + E 新增的 `find -exec rm`、`python os.system`、`base64|sh` 等模式同时保留。

逐文件处理：

| 文件 | 处理方式 |
| --- | --- |
| `src/tools/command.ts`（7 块） | D 的 pwsh7 调用路径（`getShellSpec` + `buildShellInvocation`）+ E 的 precheck / audit / rateLimit / paging / maxOutput / session env |
| `src/security.ts` | 危险模式正则取并集（D 的 PS 注入面 + E 的间接执行绕过） |
| `src/pool.ts` | 保留 D 的 pwsh7 预热池；E 的“池未激活” stub 丢弃（生产仍在使用进程池） |
| `src/utils.ts` | D 的 `safeExec`（spawnStream 统一 UTF-8）+ E 的 `envInt`；E 的 GBK smartDecode 回退随 D 的决定移除 |
| `src/stream.ts` | 导入取并集（D 的 shell 解析 + E 的 logger/IS_WIN） |
| `src/tools/search.ts` | 采用 D 的 pwsh7 内联脚本路径（参数安全转义） |
| `src/tools/system.ts` / `archive.ts` | D 的 shellSpec + `shellResolutionFail`，错误包装采用 E 的 `Errors`/`errMsg` |
| `src/tools/archive.ts` | 额外保留 E 的 `guardDestructiveAction`、`validateRealPath` |
| 测试文件 | 对齐最终实现；`tool-visibility.test.ts` 的工具数由 26/25 改为 27/26（E 新增 `temp_stats`） |
| 文档（AGENTS/README/ARCHITECTURE/roadmap 等） | 取并集，两边的说明都保留 |
| `.gitignore` | 两套规则合并（含 `tools/pwsh/` 忽略规则） |
| `package.json` / lock | 采用 E 版：SDK 锁定 1.29.0 + 零依赖 postinstall patch，Node >= 20 |

## 4. 验证清单

- [ ] `npm install`（SDK 1.29.0 与 postinstall patch 生效）
- [ ] `npm run build`
- [ ] `npx tsc --noEmit`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:latency`
- [ ] 实测 `execute_command` 在 Windows 下走 pwsh7（例如执行 `$PSVersionTable.PSVersion`）
- [ ] 实测 `MCP_COMMAND_POLICY=allow` + `MCP_COMMAND_ALLOW` 白名单生效
- [ ] 实测 hardBlock 在任何安全模式（含 off）下不可绕过
- [ ] 确认工具总数 27（新增 `temp_stats`），file_info 开关仍生效

## 5. 风险与注意点

- 合并后 `engines.node` 为 `>=20`；生产环境若为 Node 18 需先升级（开发机已确认 Node 24）。
- 合并后 MCP SDK 从 `^1.26.0` 变为锁定 `1.29.0`，需在生产环境重新 `npm install`。
- `tools/pwsh/` 为本地忽略目录，合并与回滚都不影响 pwsh7 运行时。
- E 盘的 24 个提交中，`pool.ts` 将进程池改为未激活 stub 的决定**不采纳**（与 D 生产行为冲突），这是唯一的刻意取舍，审核时请重点确认。

## 6. 审核项

- [ ] 审核第 3 节冲突规则，确认“保留 D 的 pwsh7 预热池、丢弃 E 的池 stub”的取舍
- [ ] 确认生产环境 Node 版本 >= 20
- [ ] 确认允许 SDK 锁定升级至 1.29.0
- [ ] 确认最终工具数 27 与生产侧 MCP 客户端兼容
- [ ] 审核通过后开始执行第 2 节
