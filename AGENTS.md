# AGENTS.md — 项目与 AI 协作指引

Enhanced Terminal MCP v3.1.0：通过 MCP 协议向 AI 客户端提供 27 个（默认；`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时 26 个）终端/文件/系统工具的 TypeScript 服务端。

本文件是 AI 协作的项目级硬约束入口（继承 E hardening 线的约束），所有 CodeStable 子工作流默认遵守本文件的所有规则。

## 工作前必读

1. `README.md` — 工具清单、环境变量、快速开始
2. `codestable/architecture/ARCHITECTURE.md` — 架构总入口与关键决定
3. `codestable/reference/` — CodeStable 规范：
   - `shared-conventions.md`：目录结构、frontmatter、checklist 生命周期、收尾 commit 规则
   - `code-dimensions.md`：写代码前先定维度档位
   - `tools.md`：`search-yaml.py` / `validate-yaml.py` 用法

## CodeStable 工作流

- 新功能走 `codestable/features/YYYY-MM-DD-{slug}/`：design → checklist → implement → acceptance，阶段不可跳；design 未经用户批准不写代码。
- 修 bug / 重构 / 沉淀分别走 `issues/`、`refactors/`、`compound/` 的对应约定。
- 任何 feature/issue 动手前，先搜已有归档，避免重复或与既有 decision 冲突：
  ```bash
  python codestable/tools/search-yaml.py --dir codestable --query "<关键词>"
  python codestable/tools/search-yaml.py --dir codestable/compound --filter doc_type=decision --filter status=active
  ```
- 写代码时遇到"大文件继续加职责 / 函数超一屏 / 第 4+ 个参数 / copy-paste / 万能工具类"等信号，停下来与用户对齐，不偷偷重构。
- 未经用户明确同意，不执行 `git commit`；commit 范围只含本次工作相关改动。

## 常用命令

```bash
npm run build          # tsc 编译到 build/
npm test               # vitest 全量（当前基线 35 文件 / 599 用例）
npm run test:latency   # e2e 延迟基准
npm run lint           # biome check src/ tests/
npm run format         # biome 格式化
python codestable/tools/validate-yaml.py --file <doc> --require doc_type --require status
```

## 关键技术事实

- Node.js ≥ 20，ESM；Windows 命令执行统一走 `src/shell.ts` 解析的 shell spec（默认 pwsh 7：显式路径 → bundled `tools/pwsh` → PATH → 5.1 回退；`MCP_SHELL=cmd|powershell` 可切换，详见 design `codestable/features/2026-08-16-powershell-default-shell/`），Unix 仍 `/bin/sh -c`。解析结果进程级缓存，改环境变量/装 pwsh 后需重启。
- 安全双层：`src/security.ts` 硬性底线（含 PowerShell `-EncodedCommand`/`iex`/`Start-Process` 等模式）+ `src/safeguard.ts` 三级模式；`MCP_SAFETY_MODE=strict|normal|off`（默认 normal）。
- 测试策略：`src/tools/**` 由 `tests/e2e-latency.test.ts` 子进程 e2e 覆盖，单测覆盖率排除该目录。
- `src/context.ts` 与 `src/pool.ts` 的进程池当前未被生产代码使用，改动前先确认是否需要顺带处理。
- pwsh bootstrap 只在 `setup.bat → scripts/ensure-pwsh.ps1` 联网下载（固定版本 + SHA256 + staging 原子安装）；MCP server 运行期绝不联网。`.ps1` 脚本保持纯 ASCII——中文 Windows 的 PS 5.1 会把无 BOM UTF-8 注释按 GBK 误解析。

## 项目信息

- **项目名**：Enhanced Terminal MCP
- **技术栈**：TypeScript + ESM + Node.js 20+
- **包管理器**：npm
- **构建输出**：`build/`
- **主要入口**：`src/index.ts`
- **沉淀目录**：`codestable/compound/` 存 learning / decision / trick / explore,改动前可检索相关历史沉淀

## 代码规范

- 使用 TypeScript ESM 语法，`import` 带 `.js` 扩展名
- 优先使用 `node:` 前缀导入 Node.js 内置模块
- 所有工具 handler 必须经 `wrapHandler` 包装
- 所有工具返回统一的 `ToolResult` 协议
- 函数和变量使用 camelCase，常量使用 UPPER_SNAKE_CASE
- 字符串优先使用双引号
- 不使用分号（Biome 配置决定）
- 每个函数上方保留简洁注释说明职责
- 禁止在业务代码中使用 `console.log`，统一使用 `logger`
- 空 catch 块必须补 `logger.debug` 或 `logger.warn` 并说明原因

## 禁止事项

- 禁止修改安全规则、路径黑名单、错误码等核心行为,除非逐 issue 显式授权(授权不延伸到后续 issue);安全核心含 `DANGEROUS_PATTERNS`、`HARD_BLOCK_PATTERNS`、`hardBlock`、safeguard 模式逻辑、security 硬底线
- 禁止删除仅测试使用的导出
- 禁止在 feature 实现中未经测试直接改动 `src/index.ts` 大量注册逻辑
- 禁止引入新的运行时依赖，除非已评估必要性与兼容性
- 禁止破坏现有工具的输入输出契约（工具数从 `getRegisteredToolCount()` 动态获取，勿硬编码）

## 已知坑

- `fileURLToPath` 在 Windows 路径含空格时行为不稳定，路径解析优先使用 `dirname(fileURLToPath(import.meta.url))` + `path.join`
- `build/` 目录下的 `version.js` 与 `src/version.ts` 共享相同的 package.json 相对路径逻辑
- 命令执行在 Windows 下需通过 `cmd.exe /c chcp 65001 > nul && ...` 处理 UTF-8
- 测试中的临时目录在 `afterEach` / `afterAll` 中必须清理，避免残留
- `wrapHandler` 对 handler 返回值有结构要求，直接返回裸字符串会破坏接口
- `hardBlock` 是命令执行的不可关闭底线(全模式含 off 生效),调整安全模式或命令工具入口时不得移除;详见 `codestable/compound/2026-07-11-decision-hardblock-uncloseable-baseline.md`
- 单元测试位于 `tests/unit/`（源码侧不混放 `*.test.ts`）；e2e 在 `tests/`
- `postinstall` 使用 `scripts/apply-mcp-sdk-patch.mjs`（零依赖），`patch-package` 仅 devDependency
- 命令策略：`MCP_COMMAND_POLICY=blocklist|allow`，allow 时用 `MCP_COMMAND_ALLOW` 词级白名单且禁止 shell 元字符
- 剩余 hardening / 产品边界规划：`codestable/roadmap/remaining-hardening/`（按 items 开工，禁止开放式“再补几条正则”）
- 不承诺 shell 整串执行下的形式化安全：见 `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md`

## UI 验证要求

- 本项目无前端 UI，所有改动通过 `npm run build`、`npx tsc --noEmit`、`npm run lint`、`npm test`、`npm run test:latency` 验证
