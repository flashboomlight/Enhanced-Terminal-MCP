# 安全模型与配置档

[English](./safety.md)

> 本文为英文 `safety.md` 的中文翻译版；如有出入，以英文版为准。

本服务在宿主机上执行**完整 shell 命令字符串**。其安全层是**纵深防御、而非沙箱**——不要把它暴露给不可信的客户端或网络；按设计，一个服务进程只绑定一个 stdio 客户端。文件系统边界的执行按 MCP 规范归宿主沙箱负责。威胁模型与报告流程见 [SECURITY.md](../SECURITY.md)；本页是这些开关的实操指南。

## 三种安全模式

通过 `MCP_SAFETY_MODE` 设置：

| 模式 | 行为 |
|------|------|
| `strict` | 所有受保护工具被直接拦截：`execute_command`、`batch_execute`、`watch_command`、`write_file`、`copy_move`、`delete_path`、`compress_archive`、`extract_archive`、`download_file`、`kill_process`。只读工具不受影响。 |
| `normal`（默认） | 受保护工具需要经 MCP Elicitation 逐次确认。不支持表单 Elicitation 的客户端会收到 `ELICITATION_REQUIRED` 错误。 |
| `off` | 不弹确认。hardBlock 底线仍然生效（见下）。 |

## hardBlock 底线（始终生效）

一组固定的破坏性命令模式（如磁盘擦除、fork 炸弹、`iex` 式远程脚本执行）在**任何**模式下都被拦截，包括 `MCP_SAFETY_MODE=off`。没有关闭它的开关；这是记录在案的、有意保留的底线。

## 命令策略：黑名单还是白名单

`MCP_COMMAND_POLICY` 选择命令在执行前如何筛查：

- `blocklist`（默认）——危险模式匹配 + hardBlock 底线。
- `allow`——只有 `MCP_COMMAND_ALLOW` 中列出的可执行文件（逗号分隔，如 `git,node,pnpm`）可以运行；shell 串联/元字符被拒绝。hardBlock 仍然叠加生效。

## 命令确认：all 还是 risk-gated

`MCP_COMMAND_CONFIRMATION` 调节三个命令工具（`execute_command`、`batch_execute`、`watch_command`)与安全模式的互动方式：

- `all`（默认）——`normal` 模式下每次命令工具调用都请求确认。长期以来的既有行为。
- `risk-gated`——普通命令不询问直接执行；只有**重**命令确认一次并附带原因：批量超过 5 条、带破坏性残留的命令、含性能敏感措辞的命令、`watch_command` 时长超过 60s。在 `off` 模式下这是推荐搭档：普通命令顺畅流动，重命令仍停一次。

无效值回退为 `all` 并记录启动警告。无论此项如何设置，`strict` 都会拦截命令工具。

## 纵深防御层一览

1. **hardBlock 底线**——不可关闭的破坏性模式拦截（所有模式）。
2. **安全模式**——strict/normal/off 门控十个受保护工具。
3. **命令策略**——黑名单或可执行文件白名单。
4. **路径与内容检查**——目录穿越检测、禁止路径、敏感文件模式，以及写入与缓存读取上的秘密扫描（`MCP_SECRETS_SCAN`）。
5. **网络与归档预算**——`download_file` 的 SSRF 策略、解压的 zip 炸弹防护；见[配置](./configuration.zh-CN.md#下载与归档)。
6. **限流**——命令工具上的令牌桶（10 req/s）。

## 推荐配置档

**自己机器上的个人 agent**——顺畅但不放纵：

```json
"env": { "MCP_SAFETY_MODE": "off", "MCP_COMMAND_CONFIRMATION": "risk-gated" }
```

普通命令立即执行；重命令携带风险原因停一次；hardBlock 保持开启。

**共享或 CI 环境**——每个破坏性动作都确认并留痕：

```json
"env": { "MCP_SAFETY_MODE": "normal", "MCP_COMMAND_CONFIRMATION": "all", "MCP_AUDIT_MODE": "all" }
```

**锁定主机**——只允许已知可执行文件，无 shell 元字符：

```json
"env": { "MCP_SAFETY_MODE": "strict", "MCP_COMMAND_POLICY": "allow", "MCP_COMMAND_ALLOW": "git,node,npm,pnpm" }
```

注意 `strict` 同时会完全拦截命令工具；组合配置档要想清楚（例如仍需要确认式命令执行时用 `normal` + allow 策略）。

## 本服务不承诺的事

- 不沙箱化已执行的命令——经确认的命令以你的用户权限运行。
- 没有文件系统根目录白名单（该机制已在 v4.0.0 移除）；逐次 Elicitation 确认就是边界，再加上宿主沙箱提供的任何隔离。
- 不防御恶意客户端驱使工具——信任边界就是客户端连接本身。
