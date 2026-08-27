# AGENTS.md — 项目与 AI 协作指引

Enhanced Terminal MCP v3.1.0：通过 MCP 协议向 AI 客户端提供 28 个（默认；`ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时 27 个）终端/文件/系统工具的 TypeScript 服务端。

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
pnpm run build          # tsc 编译到 build/
pnpm exec tsc --noEmit  # 独立类型检查
pnpm test               # vitest 全量
pnpm run test:latency   # e2e 延迟基准
pnpm run lint           # biome check src/ tests/
pnpm run format         # biome 格式化
pnpm run gate           # 一键完整门禁（build + tsc + lint + test + latency + 工具层覆盖）
pnpm run test:coverage:tools  # 工具层专属覆盖率门禁（vitest.tools-coverage.config.ts）
python codestable/tools/validate-yaml.py --file <doc> --require doc_type --require status
```

## 关键技术事实

- Node.js ≥ 20，ESM；Windows 命令执行统一走 `src/shell.ts` 解析的 shell spec（默认 pwsh 7：显式路径 → bundled `tools/pwsh` → PATH → 5.1 回退；`MCP_SHELL=cmd|powershell` 可切换，详见 design `codestable/features/2026-08-16-powershell-default-shell/`），Unix 仍 `/bin/sh -c`。解析结果进程级缓存，改环境变量/装 pwsh 后需重启。
- 三个命令工具已接入 `src/command-output.ts` 的共享原始字节捕获、actual 计数、流式 secret matcher、staging spill、page cache v2 与公开 A+ envelope（M2 验收时阶段 C 门禁全绿）；M3 Everything 可选解析、搜索契约和 npm 发布裁剪已验收，解析顺序为 `ENHANCED_TERMINAL_ES_PATH` → state 目录 → unavailable，运行期不下载。
- 安全双层：`src/security.ts` 硬性底线（含 PowerShell `-EncodedCommand`/`iex`/`Start-Process` 等模式）+ `src/safeguard.ts` 三级模式；`MCP_SAFETY_MODE=strict|normal|off`（默认 normal）。命令确认另有 `MCP_COMMAND_CONFIRMATION=all|risk-gated`（默认 all=全确认；risk-gated 下普通命令免确认、heavy 命令带原因 Elicitation 确认，off 只豁免 ordinary），规则表改动必须过 `tests/fixtures/command-risk-corpus.json` 语料；v4.0.0 已拆除 headless surface（DEC-002）。
- 测试策略：工具行为主要由 `tests/e2e-latency.test.ts` 子进程 e2e 覆盖；coverage 主配置排除 `src/index.ts`、`src/tools/**`、测试源码和 `tests/`，因为 V8 不能收集子进程覆盖率；工具纯逻辑由 `tests/unit/tools/` 覆盖（files/manage/system/archive 有专属单测），工具层另有专属覆盖率底线 `pnpm run test:coverage:tools`。coverage 运行还跳过延迟基准文件，避免插桩开销造成假失败。CI 见 `.github/workflows/ci.yml`（ubuntu lint/tsc；windows Node 22/24 跑 build/test/覆盖门禁，latency 非阻塞）。
- `src/context.ts` 只服务于 usage-guide prompt 的会话上下文注入，不参与命令执行链；`src/pool.ts` 当前仅保留 inactive stub，改动前先确认是否需要顺带处理。
- pwsh bootstrap 只在 `setup.bat → scripts/ensure-pwsh.ps1` 联网下载（固定版本 + SHA256 + staging 原子安装）；MCP server 运行期绝不联网。`.ps1` 脚本保持纯 ASCII——中文 Windows 的 PS 5.1 会把无 BOM UTF-8 注释按 GBK 误解析。

## 项目信息

- **项目名**：Enhanced Terminal MCP
- **技术栈**：TypeScript + ESM + Node.js 20+
- **包管理器**：pnpm 11.21.0（`packageManager` 已固定；发布包仍兼容 npm consumer）
- **依赖锁定文件**：`pnpm-lock.yaml`
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
- 使用分号（Biome 配置为 `semicolons: always`）
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
- cmd flavor 命令串无法安全携带带引号的空格路径：Node spawn 默认 argv 转义产生 `\"` 序列与 cmd 引号规则冲突（`/s` 更甚）。需要执行含空格路径下的脚本时，用 `cwd` 参数 + 纯 basename 命令规避；修改 `spawnStream`/shell 构造属执行核心，须另立 issue
- Windows 输出编码由 `src/shell.ts` 的 invocation 负责：pwsh/5.1 使用 UTF-8 preamble，cmd flavor 使用 `chcp 65001`；不要假设所有 shell 都要套 `cmd.exe /c`。
- 修改 `src/**` 后，依赖 `build/index.js` 的 e2e/latency 子进程测试必须先执行 `pnpm run build`；build 会先由 `scripts/clean-build.mjs` 清理旧产物，再生成当前编译结果
- 本项目位于 D 盘，开发依赖安装统一使用 pnpm。pnpm 的共享 content store 由机器配置决定，当前 `pnpm store path` 为 `E:/pnpm/v11`；不得把这个机器路径写入实现文件、package metadata、lockfile 或发布物。每个项目仍保留自己的 `node_modules` 和 virtual store，不共享运行时目录。
- Windows 构建、测试和相关临时数据优先使用项目内 Git 忽略的目录，例如 `D:/ALL MCP/Enhanced Terminal MCP/.etmcp/test-tmp` 与 `.etmcp/npm-cache`；不得落到 C 盘。若工具依赖 `TEMP` / `TMP` / `TMPDIR`，运行命令时将它们显式指向项目内临时目录；`.etmcp/npm-cache` 仅用于 npm clean consumer 验证
- 测试中的临时目录在 `afterEach` / `afterAll` 中必须清理，避免残留
- `wrapHandler` 对 handler 返回值有结构要求，直接返回裸字符串会破坏接口
- `hardBlock` 是命令执行的不可关闭底线(全模式含 off 生效),调整安全模式或命令工具入口时不得移除;详见 `codestable/compound/2026-07-11-decision-hardblock-uncloseable-baseline.md`
- 单元测试位于 `tests/unit/`（源码侧不混放 `*.test.ts`）；e2e 在 `tests/`
- `postinstall` 使用 `scripts/apply-mcp-sdk-patch.mjs`（零依赖），`patch-package` 仅 devDependency
- 命令策略：`MCP_COMMAND_POLICY=blocklist|allow`，allow 时用 `MCP_COMMAND_ALLOW` 词级白名单且禁止 shell 元字符
- 状态目录默认是 `<projectRoot>/.etmcp`；`MCP_STATE_DIR` 覆盖时不自动迁移 legacy 状态。`.etmcp` 根与 `temp/` 都是懒创建：只在首个真实产生物（session 持久化 / audit 写入 / temp 资源 / 迁移产物）落盘时创建，启动与读路径零创建；`getStateDir` 是纯解析，写路径用 `ensureStateDir`。
- 剩余 hardening / 产品边界规划：`codestable/roadmap/2026-07-12-remaining-hardening/`（按 items 开工，禁止开放式“再补几条正则”）
- 不承诺 shell 整串执行下的形式化安全：见 `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md`

## UI 验证要求

- 本项目无前端 UI，所有改动通过 `pnpm run build`、`pnpm exec tsc --noEmit`、`pnpm run lint`、`pnpm test`、`pnpm run test:latency` 验证
