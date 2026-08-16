---
doc_type: feature-acceptance
feature: 2026-08-16-powershell-default-shell
status: accepted
summary: Windows 命令执行默认 PowerShell、便携 bootstrap、统一 shell invocation 与安全边界已按方案落地并完成验收。
tags: [powershell, shell, cross-platform, security]
created: "2026-08-16"
last_reviewed: "2026-08-16"
---

# Windows 默认 PowerShell shell 验收报告

> 阶段：阶段 3（验收闭环）
> 验收日期：2026-08-16
> 关联方案：`codestable/features/2026-08-16-powershell-default-shell/powershell-default-shell-design.md`
> 执行清单：`powershell-default-shell-checklist.yaml`

## 1. 接口契约核对

### 1.1 名词层

- `ShellMode` 只接受 `pwsh`、`powershell`、`cmd`；默认 mode 为 `pwsh`。
- `ShellSpec` 实际包含 `file`、`flavor`、`source` 和可选 `version`；非 Windows 使用固定 `unix` flavor。
- `ShellInvocation` 只向执行器暴露 `file` 与 `args[]`，PowerShell 编码前缀和 cmd 包装均在此边界构造。
- `ResolveShellOptions` 支持注入 `env`、`projectRoot`、`exists`、`which`、`probeVersion`，选择逻辑不依赖测试机环境。
- `ShellResolutionError` 暴露 `INVALID_SHELL_MODE`、`SHELL_PATH_INVALID`、`SHELL_NOT_FOUND`，并只记录非敏感的 attempted 来源。

### 1.2 接口示例与实际行为

- 默认环境且项目 bundle 有效：实际返回 `flavor=pwsh`、`source=bundled`、`version=7.6.5`。
- `MCP_POWERSHELL_PATH` 有效时：显式路径先于 bundle/PATH，且只探测显式路径。
- `MCP_SHELL=cmd`：返回 `cmd.exe` 兼容 spec，不探测 PowerShell 候选。
- `buildShellInvocation("Write-Output 你好", pwshSpec)`：生成 `pwsh.exe` 加非交互参数、UTF-8 preamble 和 `-Command`。

### 1.3 主流程图核对

方案 2.2 的流程在代码中有完整落点：`command.ts` 先调用 `hasDangerousPattern`，再经过 SafeGuard，随后调用 `getShellSpec` / `buildShellInvocation`，最后交给 `spawnStream`；归档、系统、搜索和辅助执行器复用同一 shell spec。

## 2. 行为与决策核对

### 2.1 需求摘要

- Windows 默认 mode 为 `pwsh`，候选顺序为显式路径 → bundled → PATH → Windows PowerShell 5.1。
- pwsh 7 与 5.1 都在 invocation 层使用 UTF-8 preamble；cmd 保留 `chcp 65001`。
- `MCP_SHELL=cmd` 和 `MCP_SHELL=powershell` 保留为显式兼容档。
- shell 解析结果在进程内缓存，环境变量或 bundle 改动需要重启服务。
- 运行期不下载；便携包只由 setup 显式安装，使用固定版本、SHA256、D 盘仓库内 staging 和原子替换。
- 显式路径错误硬失败；自动候选失败可继续，全部失败返回结构化错误。

### 2.2 关键决策落地

- shell discovery、缓存和 invocation 已集中到 `src/shell.ts`；`platform.ts` 只保留兼容重导出和平台 spec。
- 所有新执行路径使用 `spawn(file, args)` 语义，不把 PowerShell 可执行文件交给 Node `exec({shell})`。
- `security.ts` 的硬性拦截先于 SafeGuard，新增 PowerShell 危险模式在 `MCP_SAFETY_MODE=off` 下仍生效。
- `ProcessPool` 只同步 shell 构造，不接入生产命令链，符合设计中的明确不做。

### 2.3 挂载点核对

| 挂载点 | 实际落点 | 结果 |
|---|---|---|
| `MCP_SHELL` / `MCP_POWERSHELL_PATH` | `src/shell.ts`、README、AGENTS | 一致 |
| setup bootstrap | `setup.bat` → `scripts/ensure-pwsh.ps1` | 一致 |
| bundled 资产登记 | `.version`、`.gitignore`、`tools/.pwsh-staging` | 一致 |
| Windows 默认命令链 | command/batch/watch/search/system/archive/stream/utils | 一致 |

反向 grep 未发现清单外的平行 shell resolver。拔除沙盘中，移除默认 shell 挂载后仍保留旧 `getShell` / `wrapCommand` 兼容入口和 cmd 兼容档；不会留下未解释的生产调用。

### 2.4 跨层纪律

- 错误语义、候选回退、进程级缓存、首次解析日志和非敏感 attempted 信息均已落地。
- bootstrap 成功、幂等跳过、hash mismatch、损坏 ZIP、版本非 7.x 五条路径均验证了 staging 清理和旧 bundle 保留。
- 本轮所有测试临时目录使用 `D:\.codex-temp-enhanced-terminal`，脚本 staging 使用仓库 D 盘 `tools/.pwsh-staging`；没有主动写入 C 盘。

## 3. 验收场景核对

### 3.1 正常与兼容场景

- **S1 bundled pwsh 7**：现有 `tools/pwsh/.version=7.6.5`，实际 executable 探测为 `7.6.5`，日志记录 `source=bundled`；通过。
- **S2 显式路径优先**：`src/shell.test.ts` 注入显式路径、bundle 和 PATH，验证只探测显式路径；通过。
- **S3 PATH pwsh 7**：resolver 单测覆盖无 bundle、PATH 有 pwsh 7 的选择和版本；通过。
- **S4 回退 5.1**：resolver 单测覆盖无 pwsh 7、有 `powershell.exe` 时的 `fallback` flavor 和 warning 语义；通过。
- **S5 `MCP_SHELL=powershell`**：单测验证不探测 bundle/PATH pwsh；通过。
- **S6 `MCP_SHELL=cmd`**：单测验证 `/c`、`chcp 65001` 和旧平台 spec 适配；通过。
- **S7 多入口一致性**：命令、batch/watch、quickExec、safeExec、platform、search、system、archive 均消费同一个缓存 spec；通过定向测试和静态引用核对。

### 3.2 错误与边界场景

- **S8 非法 mode**：`MCP_SHELL=bash` 返回 `INVALID_SHELL_MODE`，不 spawn、不静默回退；通过。
- **S9 显式路径错误**：相对路径、不存在文件、版本探测失败均返回 `SHELL_PATH_INVALID`，不继续候选；通过。
- **S10 自动候选全失败**：返回 `SHELL_NOT_FOUND`、可操作建议和非敏感 attempted 来源；通过。
- **S11 并发首次解析**：两个并发调用共享同一个 Promise，只探测一次；通过。
- **S12 有效 bundle 幂等**：重复运行 `ensure-pwsh.ps1` 输出 skip，不下载、不修改 bundle；通过。
- **S13 bootstrap 失败原子性**：受控下载器分别提供错误 hash、损坏 ZIP 和 5.1 executable；脚本分别在 hash、解压和版本校验处退出 1，staging 清理且既有 bundle 原样保留；通过。
- **S14 bootstrap 成功状态**：当前 bundle 可执行、`.version=7.6.5`、staging/zip/old 目录不存在；通过。
- **S15 PowerShell 危险模式**：`-EncodedCommand` / `-enc`、`Invoke-Expression` / `iex`、`Start-Process`、关机、执行策略和系统盘递归删除均有硬拦单测；通过。

### 3.3 回归证据

- `npm run build`：通过。
- `npm test -- --reporter=dot`：35 个测试文件、599/599 用例通过。
- `npm run test:latency -- --reporter=dot`：24 项 E2E 测量全部在阈值内。
- `npx vitest run src/shell.test.ts src/security.test.ts src/platform.test.ts src/platform.extended.test.ts`：121/121 通过。
- `npm run lint`：通过，仅保留 8 个 warning，无 error。
- design/checklist YAML、`git diff --check`：通过。

## 4. 术语一致性

方案术语 `ShellMode`、`ShellFlavor`、`ShellSpec`、`ShellInvocation`、`Bootstrap`、`Hard validation`、`MCP_SHELL`、`MCP_POWERSHELL_PATH` 均与代码和 README 一致。旧 `getShell` / `wrapCommand` 只作为兼容导出保留，没有出现新的同义 resolver。UTF-8 行为已同步修正为 pwsh 7 与 5.1 均走 invocation-layer preamble。

## 5. 架构归并

`codestable/architecture/ARCHITECTURE.md` 已包含本 feature 的稳定现状：

- `ShellSpec` / `ShellInvocation` 术语和 `src/shell.ts` 的唯一归属。
- ADR-7：Windows 默认 PowerShell、候选顺序、缓存、兼容档和 UTF-8 约束。
- ADR-13：ProcessPool 仍未接入生产执行链。
- ADR-14：bootstrap 可联网、运行期绝不联网、固定版本和原子安装边界。
- `MCP_SHELL` / `MCP_POWERSHELL_PATH` 环境变量和重启约束。

本次验收不需要再改 architecture；架构文档已经能独立说明能力形态和交互纪律。

## 6. requirement 回写

这是新增用户可感能力，已执行 backfill：

- 新增 `codestable/requirements/powershell-default-shell.md`，状态为 `current`。
- 文档只记录用户故事、痛点、当前解法和边界，不写后续计划或模块实现细节。
- design frontmatter 的 `requirement` 已回填为 `powershell-default-shell`。

## 7. roadmap 回写

design frontmatter 未设置 `roadmap` / `roadmap_item`，本 feature 不是从 roadmap 条目启动，因此不修改 roadmap items 或主文档。

## 8. AGENTS.md / CLAUDE.md 候选盘点

本 feature 暴露的长期项目约束已经存在于根目录 `AGENTS.md`：默认 shell 解析顺序、运行期不联网、D 盘 staging、PowerShell 脚本 ASCII 约束、进程级缓存和重启生效规则均已登记。本轮没有新增必须单独归档的环境陷阱。

## 9. 遗留

- 没有发现需要在本 feature 内继续修复的功能偏差。
- bootstrap 失败场景使用受控下载器提供确定性字节流，验证的是脚本真实 hash/解压/版本失败逻辑；当前已有官方固定版本 bundle 已通过实际执行验证，未重复下载完整官方 ZIP。
- Biome 的 8 个 warning 和 Vitest 的模块 mock hoisting warning 不阻断本 feature，但可作为后续独立清理项，未在本 feature 中顺手修改。
- 本次未执行 `git commit`；按项目规则等待用户明确授权 scoped commit。
