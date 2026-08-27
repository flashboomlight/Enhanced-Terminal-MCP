---
doc_type: decision
category: architecture
date: 2026-07-12
slug: command-policy-allow-optional
status: active
area: security
tags: [command-policy, allowlist, MCP_COMMAND_POLICY, hardBlock]
---

## 背景

在 hardBlock 不可关闭底线之上，需要给高安全部署（共享机器、不可信提示词、演示环境）一条**可配置的收紧旋钮**，同时不毁掉默认“AI 可跑项目脚本”的体验。

## 决定

1. 引入 **`MCP_COMMAND_POLICY`**：
   - `blocklist`（**默认**）：`hasDangerousPattern` + `hardBlock`
   - `allow`：可执行词/前缀白名单 + **禁止 shell 元字符/管道/嵌套 shell** + `hardBlock`

2. 白名单来源：`MCP_COMMAND_ALLOW`（逗号分隔）；未设置时用内置开发常用可执行名列表（npm/git/node/…）。

3. 统一入口：`checkCommandPolicy(command)`；命令三工具只走该入口。

4. **默认不得改为 allow**（见 constraint `command-execution-not-sandbox`）。

## 理由

- 配置面分离：“想收紧”的用户显式设 env；默认用户零配置。
- allow 下禁元字符，避免 `npm test; curl evil` 这类前缀绕过，而不假装完整 shell 解析。
- hardBlock 仍在最前，防止有人把 `rm` 写进 ALLOW。

## 考虑过的替代方案

- **仅扩充黑名单**：无法满足高安全部署“只准白名单”的需求。
- **默认 allow**：否决（产品能力）。
- **完整 argv 工具替代**：留给 B 轨 `model-argv-execute-design`，与本配置并存而非互相替代。

## 后果

- README / AGENTS 必须记录两个环境变量。
- allow 模式误拦（合法命令含 `|` 等）是**可接受代价**；用户应改 blocklist 或拆命令。
- 改默认策略或弱化元字符拦截 = 架构变更，需更新本 decision + roadmap。

## 相关文档

- `src/command-policy.ts`
- `codestable/roadmap/2026-07-12-remaining-hardening/remaining-hardening-roadmap.md` §4.1
- `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md`
