---
doc_type: decision
category: constraint
date: 2026-07-12
slug: command-execution-not-sandbox
status: active
area: security
tags: [security, execute_command, shell, sandbox, hardBlock, command-policy]
---

## 背景

Enhanced Terminal MCP 的核心价值之一是让 AI 客户端通过 `execute_command` / `batch_execute` / `watch_command` 执行**真实 shell 命令**（Windows 上 `cmd.exe /c`，Unix 上 `sh -c`）。  
2026-07 安全加固引入了 hardBlock、危险模式黑名单、可选 allow 白名单、禁 shell 元字符等应用层控制。团队反复遇到同一问题：

> “能否把命令执行做到绝对安全 / 再补几条正则是否就完备？”

若不把答案写成永久约束，后续会无限“挤牙膏”式加规则，并产生错误的安全预期。

## 决定

1. **应用层命令控制是纵深防御，不是沙箱完备性证明。**  
   在保留“整串 shell 命令”执行模型的前提下，**不承诺**、**不验收**“任意恶意字符串均被拦下”的形式化安全目标。

2. **默认产品语义保持 `MCP_COMMAND_POLICY=blocklist`（任意命令 + 黑名单/hardBlock）。**  
   `allow` 是**可选加固配置**，不得在未单独产品决策的情况下改为默认。

3. **若需要接近完备的执行隔离，必须改变执行模型或引入 OS 级隔离**，并作为独立 roadmap 子项（`model-argv-execute-design` / `model-os-sandbox-spike`）走 design，而不是继续扩展正则。

4. **允许并鼓励**在应用层继续做**可回归、可测**的增强（语料库、hardBlock 扩展、allow 禁拼接），但每条增强必须挂在 `remaining-hardening` 的 item 上，并优先“漏拦灾难 > 误拦常用开发命令”。

## 理由

- **理论**：完整 shell 语言 + 环境展开 + 编码 + 解释器内联，无法用有限正则集合判定“安全”。  
- **产品**：AI 编程终端的价值依赖 `npm`/`git`/`tsc` 等真实命令；默认强制白名单等于更换产品。  
- **工程**：无限加规则导致误报、难测、与 AGENTS 安全红线冲突（每次改 HARD_BLOCK 需授权）。  
- **已有分层**：safeguard 模式、hardBlock、allow、路径安全、审计 — 目标是“降低事故面”，不是“军用沙箱”。

## 考虑过的替代方案

| 方案 | 未默认采用的原因 |
|------|------------------|
| 默认仅 allow 白名单 | 破坏核心能力；用户设 off/normal 时期望能跑项目脚本 |
| 自研完整 shell 解析器作安全核 | 成本极高、仍有语义漏洞、误拦严重 |
| 默认容器内执行 | 运行时依赖、权限、体积、Windows 体验；属 B 轨 spike |
| 取消 execute_command | 产品不成立 |

## 后果

- 安全文档、README、对外承诺必须写清：**加固 ≠ 沙箱**。  
- 安全 issue 的验收标准应是“针对语料库的回归”与“已知类别覆盖”，不是“无法构造任何绕过”。  
- 发现新的**灾难性**可复现绕过：优先加入 hardBlock 语料 + 模式；若属于“需要 shell 才能表达的通用能力”，评估是否应推用户改用 allow 或未来 argv 工具。  
- 与 `2026-07-11-decision-hardblock-uncloseable-baseline` 关系：hardBlock 仍是不可关闭底线；本决定约束的是**对 hardBlock/黑名单完备性的预期**，不削弱 hardBlock 的强制调用。

## 相关文档

- `codestable/roadmap/remaining-hardening/remaining-hardening-roadmap.md`
- `codestable/compound/2026-07-11-decision-hardblock-uncloseable-baseline.md`
- `codestable/compound/2026-07-12-decision-zod-v3-remain.md`
- `AGENTS.md` 安全核心红线
