# Installation & Client Setup

Enhanced Terminal MCP is a **stdio MCP server**: your MCP client launches it as a child process and talks JSON-RPC over stdin/stdout. There is no daemon, no port, and no remote mode. The server never downloads anything at runtime.

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Node.js ≥ 20 | Runtime requirement (declared in `engines`). |
| Node.js ≥ 22.13 | Only for building from source — the pinned pnpm 11.21.0 requires it. |
| pnpm 11.21.0 or npm | pnpm is pinned via the `packageManager` field; npm also works for install + build. |
| PowerShell 7 (`pwsh`) | Windows only, recommended. Resolved from `MCP_POWERSHELL_PATH` → bundled `tools/pwsh` (installed by `setup.bat`) → `PATH` → Windows PowerShell 5.1 fallback. See [Platform Notes](../README.md#platform-notes). |
| `zip` / `unzip` binaries | Linux/macOS only, for `compress_archive` / `extract_archive` (e.g. `apt-get install -y zip unzip`). |

## Install from source (current path)

The npm package is **not yet published** — building from a source checkout is the installation method today.

```bash
git clone https://github.com/flashboomlight/Enhanced-Terminal-MCP.git
cd Enhanced-Terminal-MCP
pnpm install        # or: npm install
pnpm run build      # or: npm run build
```

The server entry point is `build/index.js`.

On Windows, `setup.bat` is an alternative bootstrap: it installs dependencies with the pinned pnpm version, builds `build/index.js`, then runs the explicit fixed-version pwsh bootstrap (SHA256-verified, staged atomic install into `tools/pwsh`). Use `setup.bat --no-pwsh` to skip that optional download, and add `--non-interactive` for CI or automation. On Linux/macOS the plain install + build above is the whole setup — no pwsh is needed.

## Connect your MCP client

Every stdio-capable MCP client uses the same shape — command `node`, one argument with the **absolute** path to `build/index.js`, optional `env` variables (see [Configuration Reference](./configuration.md)):

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

Where that JSON lives depends on the client:

| Client | Where to add it |
|--------|-----------------|
| Claude Desktop | `claude_desktop_config.json` — Windows: `%APPDATA%\Claude\`; macOS: `~/Library/Application Support/Claude/` |
| Cursor | Global `~/.cursor/mcp.json`, or per-project `.cursor/mcp.json` |
| VS Code (Copilot MCP) | Workspace `.vscode/mcp.json` (uses a top-level `"servers"` key instead of `"mcpServers"`) |
| Cherry Studio | Settings → MCP Servers → add a stdio server with the same command/args/env |

Client config locations change over time — treat the table as a starting point and check your client's current documentation if the path differs.

Recommended starting profile for personal use: `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated` (ordinary commands run immediately; heavy commands confirm once with the reason). Rationale and alternatives: [Safety Model & Profiles](./safety.md).

## Verify the installation

1. Restart/reload the client after editing its config.
2. The client's tool list should show **27 tools** (26 if `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`).
3. Read the `health://status` resource — expect `"status": "healthy"` with component details.
4. The `usage-guide` prompt gives the model a capability overview; `safety-info` reports the live safety configuration.

If something is off, see [Troubleshooting](./troubleshooting.md).

## npm package (planned)

Publishing to npm is planned but has not happened yet. Once published, the package will install as `enhanced-terminal-mcp` with a bin entry of the same name, so the client config becomes `{ "command": "enhanced-terminal-mcp" }` (global install) or `npx --yes enhanced-terminal-mcp` (project-local). Notes that will matter then:

- Installation must allow lifecycle scripts — `postinstall` applies the pinned MCP SDK compatibility patch (`scripts/apply-mcp-sdk-patch.mjs`).
- The npm package does not include `setup.bat`, the source tree, bundled pwsh, or any Everything components, and it never downloads pwsh at install or runtime. On Windows it resolves `MCP_POWERSHELL_PATH` → pwsh on `PATH` → Windows PowerShell 5.1.

---

> This project makes no guarantees about update frequency, issue resolution timelines, or long-term support.
