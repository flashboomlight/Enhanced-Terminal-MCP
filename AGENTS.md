# AGENTS.md — 项目与 AI 协作指引

Enhanced Terminal MCP v3.1.0：通过 MCP 协议向 AI 客户端提供 26 个终端/文件/系统工具的 TypeScript 服务端。

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

- Node.js ≥ 18，ESM；Windows 命令执行统一走 `src/shell.ts` 解析的 shell spec（默认 pwsh 7：显式路径 → bundled `tools/pwsh` → PATH → 5.1 回退；`MCP_SHELL=cmd|powershell` 可切换，详见 design `codestable/features/2026-08-16-powershell-default-shell/`），Unix 仍 `/bin/sh -c`。解析结果进程级缓存，改环境变量/装 pwsh 后需重启。
- 安全双层：`src/security.ts` 硬性底线（含 PowerShell `-EncodedCommand`/`iex`/`Start-Process` 等模式）+ `src/safeguard.ts` 三级模式；`MCP_SAFETY_MODE=strict|normal|off`（默认 normal）。
- 测试策略：`src/tools/**` 由 `tests/e2e-latency.test.ts` 子进程 e2e 覆盖，单测覆盖率排除该目录。
- `src/context.ts` 与 `src/pool.ts` 的进程池当前未被生产代码使用，改动前先确认是否需要顺带处理。
- pwsh bootstrap 只在 `setup.bat → scripts/ensure-pwsh.ps1` 联网下载（固定版本 + SHA256 + staging 原子安装）；MCP server 运行期绝不联网。`.ps1` 脚本保持纯 ASCII——中文 Windows 的 PS 5.1 会把无 BOM UTF-8 注释按 GBK 误解析。
