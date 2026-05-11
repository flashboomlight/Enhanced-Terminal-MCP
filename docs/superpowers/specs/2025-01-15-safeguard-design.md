# SafeGuard 安全锁系统设计规格

## 概述

为 Enhanced Terminal MCP v3.0 的所有敏感操作增加集中式安全锁机制。通过三级安全模式、MCP Elicitation 交互式确认、关键资源硬性保护三层防御，实现「防误操作」级别的安全保障。

## 背景

当前 v3.0 存在以下安全缺口：

- `delete_path` 递归删除目录无任何确认机制
- `write_file` 覆写已有文件无提示
- `kill_process` 可杀任意进程含系统关键进程
- `execute_command` 危险命令拦截后 `watch_command` 仍然放行
- 无全局安全开关，无法快速切换安全级别

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 使用场景 | 个人本地开发 | 安全策略以防误操作为主，非防恶意攻击 |
| 确认方式 | MCP Elicitation 交互式确认 | 用户在客户端 UI 手动确认才执行 |
| 全局模式 | 三级 (strict/normal/off) | 灵活切换，兼顾安全与效率 |
| 保护范围 | 核心五个工具 | delete_path, write_file 覆写, kill_process, execute_command/batch_execute/watch_command 危险命令 |
| 降级策略 | 客户端不支持 Elicitation 时拒绝执行 | 安全优先于便利 |
| 架构 | 集中式安全引擎 safeguard.ts | 一处维护，工具层最小改动 |

## 架构

```
index.ts
  ├── 读取 MCP_SAFETY_MODE 环境变量
  ├── 创建 createElicitationHelper(server) 并注入到 safeguard
  └── SafeGuard 在各工具 handler 中被调用

safeguard.ts (新增)
  ├── getSafetyMode() → "strict" | "normal" | "off"
  ├── initSafeGuard(server) — 接收 McpServer 实例以获取 Elicitation 能力
  ├── guardDestructiveAction(toolName, description) → null | 拒绝原因
  └── isCriticalProcess(name, pid) → boolean

security.ts (已有，不变)
  ├── validatePath()       — 路径穿越 + 禁止列表
  ├── hasDangerousPattern() — 危险命令正则
  └── sanitizeProcessName() — 进程名消毒
```

`security.ts` 做输入校验（硬性底线），`safeguard.ts` 做操作确认（策略层）。两层独立，互不替代。

**Elicitation 实现方式说明**：MCP SDK 的 Elicitation 能力挂载在 `McpServer` 实例上（通过 `server.server.createElicitation()` 或类似 API），而非 `extra` 对象。因此 `safeguard.ts` 需要在初始化时接收 `server` 实例引用，内部封装 Elicitation 调用。如果 SDK 版本不支持 Elicitation API 或调用抛出 "not supported" 类错误，视为客户端不支持，执行降级拒绝策略。

## 三级安全模式

### strict 模式

safeguard 内部维护一份受保护的工具名单：`delete_path`、`write_file`、`kill_process`、`execute_command`、`batch_execute`、`watch_command`。strict 模式下这些工具的调用直接被拒绝，返回错误信息（不依赖 annotations 判断，而是显式名单）：

```
[SAFETY] Operation blocked: server is running in strict safety mode.
Tool "delete_path" is marked as destructive and cannot be executed.
Switch to normal mode (MCP_SAFETY_MODE=normal) to enable with confirmation.
```

适用场景：演示环境、不信任的 Agent。

### normal 模式（默认）

敏感操作执行前通过 MCP Elicitation 向用户弹出确认对话框。用户在客户端 UI 中看到操作详情并手动确认后才执行。

如果客户端不支持 Elicitation（SDK API 不可用或调用抛出 "not supported" / "method not found" 类错误），则拒绝执行并返回提示：

```
[SAFETY] This operation requires user confirmation, but the MCP client
does not support interactive confirmation (Elicitation).
Please either:
  1. Use a client that supports Elicitation (e.g. Claude Desktop)
  2. Set MCP_SAFETY_MODE=off to disable safety checks
```

### off 模式

所有安全锁检查跳过。行为等同于升级前的 v3.0。向后兼容。

注意：off 模式下 `security.ts` 的硬性底线仍然生效（系统目录禁止列表、路径穿越检测、关键进程黑名单）。

## 各工具保护规则

### delete_path

| 场景 | strict | normal | off |
|------|--------|--------|-----|
| 路径在禁止列表 | 拒绝 | 拒绝 | 拒绝（硬性底线） |
| 删除单个文件 | 拒绝 | Elicitation 确认 | 直接执行 |
| 递归删除目录 | 拒绝 | Elicitation 确认（显示目录统计） | 直接执行 |

确认对话框内容：
- 工具名、目标路径
- 是否递归
- 如果是目录：文件数量和子目录数量（调 `fs.readdir` 统计）
- 文件大小（如果是单文件）

### write_file

| 场景 | strict | normal | off |
|------|--------|--------|-----|
| 路径在禁止列表 | 拒绝 | 拒绝 | 拒绝（硬性底线） |
| 文件不存在（新建） | 拒绝 | 直接写入 | 直接写入 |
| 文件已存在（覆写） | 拒绝 | Elicitation 确认 | 直接执行 |
| append 追加模式 | 拒绝 | 直接执行 | 直接执行 |

确认对话框内容：
- 目标路径
- 已有文件大小 + 最后修改时间
- 提醒将被覆写

### kill_process

| 场景 | strict | normal | off |
|------|--------|--------|-----|
| 关键进程黑名单 | 拒绝 | 拒绝 | 拒绝（硬性底线） |
| 普通进程 | 拒绝 | Elicitation 确认 | 直接执行 |

关键进程黑名单：
- Windows: `csrss.exe`, `wininit.exe`, `smss.exe`, `lsass.exe`, `services.exe`, `svchost.exe`, `dwm.exe`, `explorer.exe`, `winlogon.exe`, `System`
- Unix: `init`, `systemd`, `launchd`, `kernel`

确认对话框内容：
- 进程名或 PID
- 是否 force kill

### execute_command / batch_execute / watch_command

| 场景 | strict | normal | off |
|------|--------|--------|-----|
| 命中危险模式正则 | 拒绝 | Elicitation 确认 | 直接执行 |
| 不危险的普通命令 | 拒绝(所有命令) | 直接执行 | 直接执行 |

注意：
- `watch_command` 当前缺少危险模式检查，本次修复加上。
- `batch_execute` 已有 `hasDangerousPattern` 检查，本次追加 Elicitation 确认逻辑。
- strict 模式通过显式工具名单判断（而非 annotations），因此即使 `watch_command` 标注了 `readOnlyHint: true`，在 strict 模式下命令执行类工具仍全部禁用。

确认对话框内容：
- 完整命令内容
- 命中的危险模式描述（如 "匹配到 rm -rf / 模式"）

## safeguard.ts 接口设计

```typescript
type SafetyMode = "strict" | "normal" | "off";

/**
 * 读取当前安全模式。从 MCP_SAFETY_MODE 环境变量获取，默认 "normal"。
 */
export function getSafetyMode(): SafetyMode;

/**
 * 初始化安全锁 — 接收 McpServer 实例以获取 Elicitation 能力。
 * 在 index.ts 中 server 创建后、工具注册前调用一次。
 */
export function initSafeGuard(server: McpServer): void;

/**
 * 安全锁检查 — 破坏性操作的统一入口。
 * 内部通过初始化时注入的 server 实例调用 Elicitation。
 *
 * @param toolName - 工具名称
 * @param description - 人类可读的操作描述
 * @returns null 表示放行，string 表示拒绝原因
 */
export async function guardDestructiveAction(
  toolName: string,
  description: string,
): Promise<string | null>;

/**
 * 检查是否为关键系统进程。所有模式下生效。
 */
export function isCriticalProcess(name?: string, pid?: number): boolean;
```

## 工具层接入方式

每个敏感工具的 handler 在已有的路径校验之后、实际执行之前，插入一行安全锁调用：

```typescript
const blocked = await guardDestructiveAction("delete_path", desc);
if (blocked) return fail(blocked);
```

不需要修改工具的 inputSchema、annotations 或其他元信息。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_SAFETY_MODE` | `normal` | 安全模式：strict / normal / off |

## 测试计划

新增 `tests/safeguard.test.ts`：

1. **strict 模式**：delete/write/kill/execute/batch_execute/watch 全部直接被拒绝
2. **off 模式**：delete/write/kill/execute/batch_execute/watch 全部直接放行
3. **硬性底线（off 模式）**：系统目录删除仍被拒、关键进程仍被拒、路径穿越仍被拒
4. **Elicitation 降级**：模拟客户端不支持 Elicitation，验证返回友好拒绝信息
5. **write_file 新建 vs 覆写**：新文件直接写入、已有文件触发确认
6. **关键进程黑名单**：csrss/svchost/explorer 等全部被拒
7. **batch_execute 保护**：批量命令中含危险命令时触发确认

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `src/safeguard.ts` | 新增 |
| `src/tools/command.ts` | 修改：execute_command、batch_execute 和 watch_command 接入安全锁 |
| `src/tools/files.ts` | 修改：write_file 接入覆写保护 |
| `src/tools/manage.ts` | 修改：delete_path 接入安全锁 |
| `src/tools/system.ts` | 修改：kill_process 接入安全锁 + 关键进程黑名单 |
| `src/index.ts` | 修改：启动日志显示安全模式 |
| `tests/safeguard.test.ts` | 新增 |
