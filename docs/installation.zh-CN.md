# 安装与客户端接入

[English](./installation.md)

> 本文为英文 `installation.md` 的中文翻译版；如有出入，以英文版为准。

Enhanced Terminal MCP 是一个 **stdio MCP 服务端**：MCP 客户端把它作为子进程启动，通过 stdin/stdout 通信 JSON-RPC。没有守护进程、没有端口、没有远程模式。服务在运行期绝不下载任何东西。

## 前置条件

| 要求 | 说明 |
|------|------|
| Node.js ≥ 20 | 运行时要求（声明于 `engines`）。 |
| Node.js ≥ 22.13 | 仅从源码构建时需要——固定的 pnpm 11.21.0 要求它。 |
| pnpm 11.21.0 或 npm | pnpm 经 `packageManager` 字段固定；npm 也可完成安装 + 构建。 |
| PowerShell 7（`pwsh`） | 仅 Windows，推荐提供。解析顺序：`MCP_POWERSHELL_PATH` → 捆绑 `tools/pwsh`（由 `setup.bat` 安装）→ `PATH` → Windows PowerShell 5.1 回退。见[平台说明](../README.zh-CN.md#平台说明)。 |
| `zip` / `unzip` 二进制 | 仅 Linux/macOS，供 `compress_archive` / `extract_archive` 使用（如 `apt-get install -y zip unzip`）。 |

## 从源码安装（当前方式）

npm 包**尚未发布**——当前的安装方式就是从源码检出构建。

```bash
git clone https://github.com/flashboomlight/Enhanced-Terminal-MCP.git
cd Enhanced-Terminal-MCP
pnpm install        # 或：npm install
pnpm run build      # 或：npm run build
```

服务入口是 `build/index.js`。

Windows 上可用 `setup.bat` 作为替代引导：以固定的 pnpm 版本安装依赖、构建 `build/index.js`，然后运行显式固定版本的 pwsh 引导（SHA256 校验、staging 原子安装到 `tools/pwsh`）。用 `setup.bat --no-pwsh` 跳过该可选下载，加 `--non-interactive` 适配 CI 或自动化。Linux/macOS 上，上面的安装 + 构建即全部所需——不需要 pwsh。

## 接入 MCP 客户端

所有支持 stdio 的 MCP 客户端都用同一形态——command 为 `node`，一个参数指向 `build/index.js` 的**绝对**路径，可选 `env` 变量（见[配置参考](./configuration.zh-CN.md)）：

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "node",
      "args": ["D:\\path\\to\\Enhanced-Terminal-MCP\\build\\index.js"],
      "env": {
        "MCP_SAFETY_MODE": "off",
        "MCP_COMMAND_CONFIRMATION": "risk-gated"
      }
    }
  }
}
```

这段 JSON 放在哪取决于客户端：

| 客户端 | 添加位置 |
|--------|----------|
| Claude Desktop | `claude_desktop_config.json`——Windows：`%APPDATA%\Claude\`；macOS：`~/Library/Application Support/Claude/` |
| Cursor | 全局 `~/.cursor/mcp.json`，或项目级 `.cursor/mcp.json` |
| VS Code (Copilot MCP) | 工作区 `.vscode/mcp.json`（顶层用 `"servers"` 键而不是 `"mcpServers"`） |
| Cherry Studio | 设置 → MCP 服务器 → 添加 stdio 服务，填相同的 command/args/env |

客户端配置位置会随时间变化——把本表当起点，路径不符时查你所用客户端的当前文档。

个人使用的推荐起始配置档：`MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`（普通命令立即执行；重命令携带原因确认一次）。理由与替代方案见[安全模型与配置档](./safety.zh-CN.md)。

## 验证安装

1. 改完配置后重启/重载客户端。
2. 客户端工具列表应显示 **27 个工具**（设置了 `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` 时为 26 个）。
3. 读取 `health://status` 资源——期望 `"status": "healthy"` 及组件详情。
4. `usage-guide` prompt 向模型提供能力概览；`safety-info` 报告实时安全配置。

如有异常，见[排错](./troubleshooting.zh-CN.md)。

## npm 包（计划中）

npm 发布已列入计划但尚未发生。发布后，包将以 `enhanced-terminal-mcp` 安装，bin 入口同名，客户端配置会变成 `{ "command": "enhanced-terminal-mcp" }`（全局安装）或 `npx --yes enhanced-terminal-mcp`（项目内）。届时需要注意的几点：

- 安装必须允许生命周期脚本——`postinstall` 会应用固定的 MCP SDK 兼容补丁（`scripts/apply-mcp-sdk-patch.mjs`）。
- npm 包不包含 `setup.bat`、源码树、捆绑 pwsh 或任何 Everything 组件，安装期与运行期都绝不下载 pwsh。Windows 上解析 `MCP_POWERSHELL_PATH` → `PATH` 上的 pwsh → Windows PowerShell 5.1。
