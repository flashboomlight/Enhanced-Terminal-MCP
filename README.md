# Enhanced Terminal MCP Server v3.1

A powerful terminal/CLI interface for AI models via the [Model Context Protocol (MCP)](https://modelcontextprotocol.org/).

Supports **28 tools** across 7 categories: command execution, file I/O, system management, search, archives, telemetry, and session management.

## Features

- **3-Level Safety System** — strict/normal/off via `MCP_SAFETY_MODE`, hardBlock baseline always on; optional `MCP_COMMAND_POLICY=allow`
- **Path & URL Security** — traversal detection, forbidden paths, sensitive file patterns, secret scanning
- **Performance Optimized** — LRU result cache (128-entry, sliding TTL, ~32MB cap), adaptive timeouts, spawn-based streaming
- **Structured Errors** — 20 error codes with `retryable`, `suggestion`, and `param` hints for LLMs
- **Session Persistence** — cwd, env vars, and command history survive restarts (auto-saved to `.etmcp/session.json`)
- **Audit Logging** — structured JSON Lines audit log at `.etmcp/logs/audit.jsonl` (mode: `off` / `errors` / `all`)
- **Temp Resource Manager** — TTL + LRU auto-recycled temp directories; the `temp` root is created only when a temp resource is actually needed
- **Command Output Paging** — large `execute_command` outputs spill to a byte-indexed page cache v2 under `.etmcp/temp` and can be read page-by-page via validated `cache_id` / `page` / `pageSize`; small outputs stay in memory and never touch disk
- **Rate Limiting** — token bucket (10 req/s) for command execution
- **Windows Everything Integration (optional)** — sub-10ms file search via Everything CLI, resolved locally from `ENHANCED_TERMINAL_ES_PATH` or `<state-dir>/tools/es.exe` with a locked SHA-256; `search_files` falls back to native search when unavailable

## Quick Start

```bash
# Install
npm install enhanced-terminal-mcp

# Windows one-click setup (also installs bundled pwsh 7 as the default shell;
# pass --no-pwsh to skip — the server then falls back to Windows PowerShell 5.1)
setup.bat

# Configure in Claude Desktop / Cherry Studio / etc.
# Add to your MCP config:
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "node",
      "args": ["path/to/enhanced-terminal-mcp/build/index.js"]
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SAFETY_MODE` | `normal` | `strict` (all destructive blocked), `normal` (confirm destructive tools), `off` (no checks; hardBlock still on) |
| `MCP_CONFIRMATION_MODE` | `elicitation` | `elicitation` (interactive confirmation), `auto` (use Elicitation only when the client advertises form support), `headless` (workspace-delete only; requires `MCP_ALLOWED_ROOTS`) |
| `MCP_ALLOWED_ROOTS` | — | Absolute path list separated by the platform delimiter; required for `MCP_CONFIRMATION_MODE=headless`. The headless surface is limited to `delete_preview` and preview-bound `delete_path`; the configured roots themselves cannot be deleted. |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist` (dangerous patterns + hardBlock) or `allow` (executable allowlist + hardBlock; no shell chaining) |
| `MCP_COMMAND_ALLOW` | built-in list | Comma-separated executables/prefixes when policy is `allow` (e.g. `npm,git,node`) |
| `MCP_BATCH_RATE_MODE` | `batch` | `batch` (1 token per batch_execute) or `per_command` (1 token per command in batch) |
| `MCP_SECRETS_SCAN` | `cache` | `off` / `write` / `cache` / `strict` (strict also blocks secret-bearing read_file content) |
| `MCP_LOG_LEVEL` | `info` | Log level: debug / info / warn / error |
| `MCP_SHELL` | `pwsh` | Windows shell mode: `pwsh` (PowerShell 7, recommended), `powershell` (Windows PowerShell 5.1), `cmd` (legacy cmd.exe escape hatch). Unix is unaffected. |
| `MCP_POWERSHELL_PATH` | — | Explicit path to a pwsh 7 / PowerShell executable. Takes highest priority; invalid path is a hard error (no silent fallback). |
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | State directory for session, audit logs, and temp files. With the default root, legacy `<project-root>/.enhanced-terminal-mcp` `session.json`/`logs/audit.jsonl` are migrated; `temp` and unknown files are never migrated. Setting this override disables automatic legacy migration. |
| `MCP_AUDIT_MODE` | `errors` | Audit mode: `off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | Max audit log entries to retain |
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | Max captured stdout bytes retained per command before the result is flagged `truncated` and spilled to the page cache; see `MCP_COMMAND_MEMORY_OUTPUT_BYTES` for the in-memory spill threshold |
| `MCP_TEMP_TTL_MS` | `3600000` | Temp directory TTL in milliseconds |
| `MCP_MAX_TEMP_DIRS` | `100` | Max temp directories before LRU eviction |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | Auto cleanup polling interval in milliseconds |
| `MCP_COMMAND_MEMORY_OUTPUT_BYTES` | `1048576` | In-memory retention threshold per command; output beyond this spills to the page cache (`paged=true`) |
| `MCP_COMMAND_MAX_STDERR_BYTES` | `1048576` | Max stderr bytes retained per command |
| `MCP_TEMP_MAX_TOTAL_BYTES` | `1073741824` | Max total temp bytes before LRU eviction kicks in |
| `ENHANCED_TERMINAL_ES_PATH` | — | Explicit path to a fixed-SHA-256 Everything CLI (`es.exe`). Takes priority over `<state-dir>/tools/es.exe`; an invalid explicit path fails closed. `search_files` falls back only when the implicit state binary is unavailable; `everything_search` returns structured installation detail. |

### Windows Default Shell (pwsh 7)

On Windows, command tools resolve a shell once per process, in this order:

1. `MCP_POWERSHELL_PATH` (explicit, fail-closed)
2. Bundled portable pwsh 7 at `tools/pwsh/pwsh.exe` (installed by `setup.bat`, fixed version + SHA256 verified)
3. pwsh 7 found on `PATH`
4. Windows PowerShell 5.1 fallback (logs a warning)

pwsh 7 and Windows PowerShell 5.1 use the invocation-layer UTF-8 preamble; cmd keeps `chcp 65001`. Use `MCP_SHELL=cmd` to restore the legacy cmd.exe behavior. The cmd/powershell inline non-ASCII mojibake issue was fixed in the M2 output-decoding layer (`src/command-output.ts`); see `codestable/issues/2026-08-19-cmd-powershell-inline-mojibake/`. Changing shells or installing pwsh requires a server restart (resolution is cached for the process lifetime).

## Tool Reference

### Command Tools
| Tool | Description | Safety |
|------|-------------|--------|
| `execute_command` | Execute a shell command, or read cached paged output via `cache_id` (`page`/`pageSize`) | destructive |
| `batch_execute` | Execute multiple commands sequentially (default) or in parallel with concurrency 4 | destructive |
| `watch_command` | Run a command for a limited duration, capturing output and failing on non-zero exit | destructive |

### File Tools
| Tool | Description | Cache |
|------|-------------|-------|
| `read_file` | Read file with paging (offset/limit), encoding auto-detection | 30s |
| `write_file` | Write or append content; secret scanning blocks credential writes | — |
| `list_directory` | Recursive listing with symlink cycle protection, batch stat | 5s |
| `file_info` | Size, type, timestamps | 30s |
| `make_directory` | Create directory with parents | — |

### File Management
| Tool | Description |
|------|-------------|
| `copy_move` | Copy or move files/directories; protected by safety confirmation |
| `delete_preview` | Preview a file or directory deletion without changing the filesystem |
| `delete_path` | Delete file or directory (requires recursive for non-empty dirs) |

For a non-interactive harness, set `MCP_CONFIRMATION_MODE=headless` and `MCP_ALLOWED_ROOTS`. Every headless deletion must use `delete_preview` first; command, write, archive, download, and process tools are not part of this headless surface.

### Search Tools
| Tool | Description | Cache |
|------|-------------|-------|
| `search_files` | Pattern search with Everything on Windows, native fallback | 30s |
| `everything_search` | Ultra-fast Everything search (Windows only) | 30s |
| `grep_content` | Regex content search via PowerShell/grep/native with global `max_results` | 30s |

### System Tools
| Tool | Description |
|------|-------------|
| `get_system_info` | OS, CPU, memory, disk, GPU details | 60s cache |
| `process_list` | Filterable process listing |
| `kill_process` | Kill by PID or name (protected processes blocked) |
| `network_info` | config / connections / ping / dns |
| `environment_vars` | List with sensitive key masking |

### Archive Tools
| Tool | Description |
|------|-------------|
| `compress_archive` | Zip compression; protected by safety confirmation |
| `extract_archive` | Zip extraction; protected by safety confirmation |
| `download_file` | HTTP(S) download with retry; protected by safety confirmation |

### Utility Tools
| Tool | Description |
|------|-------------|
| `telemetry_report` | Tool call metrics: latency, errors, cache hit rates, temp stats, audit status |
| `temp_stats` | Temp resource statistics: dirs, size, oldest/newest age, removed count |
| `cache_stats` | LRU cache statistics |
| `cache_invalidate` | Clear specific or all caches |
| `session_state` | View/modify session cwd and env (get/set_cwd/set_env/reset); env applies to command tools |
| `pool_stats` | Process pool status (currently inactive; no worker pool is active) |

### Resources
- `health://status` — JSON health check with version, metrics, cache, session, temp, and audit info
- `audit://log?limit=N` — Recent structured audit entries

### Prompts
- `usage-guide` — Tool overview (includes live session context)
- `safety-info` — Current safety configuration

## Architecture

```
MCP Client (stdio) → McpServer
  ├─ 7 tool modules (command, files, manage, search, system, archive, utility)
  ├─ utility tools (telemetry, temp, cache, session, pool_stats, …)
  ├─ wrapHandler middleware (telemetry + LRU cache)
  ├─ Security layer (path validation, dangerous patterns, secrets)
  ├─ SafeGuard (3-level safety mode)
  ├─ Rate limiting (token bucket)
  ├─ Session persistence (JSON file)
  ├─ ProcessPool (inactive stub; stats only — execution uses spawnStream)
  ├─ Adaptive timeouts (P95-based × 3)
  └─ Structured errors (19 codes)
```

## Development

```bash
pnpm install
pnpm run build          # clean build/ and compile TypeScript
pnpm exec tsc --noEmit  # Type-check without emitting
pnpm test               # Run unit tests
pnpm run test:latency   # E2E latency benchmarks
pnpm run lint           # Biome linter
pnpm run format         # Biome formatter
```

Development uses pnpm `11.21.0`. pnpm can reuse a machine-configured shared content store; on the maintainer machine, `pnpm store path` is `E:\pnpm\v11`. This path is configuration, not part of the repository contract. Each MCP project keeps its own `node_modules`, virtual store, and lockfile. Do not share a runtime `node_modules` directory or use `NODE_PATH` between projects. The published package remains installable by npm as shown in Quick Start.

## Supply chain & integrity

| Artifact | Notes |
|----------|--------|
| `es_tool/es.exe` | Everything CLI development/test fixture only (locked to `ES_EXE_SHA256` in `src/es-integrity.ts`: `5101b3a6d9542de378e077f4b8c66c4e608d3bff088092427749b65fbb18b342`). Production resolves `ENHANCED_TERMINAL_ES_PATH` → `<state-dir>/tools/es.exe` → unavailable; the fixture is not included in the npm package. Update binary ⇒ update constant + tests. |
| `scripts/apply-mcp-sdk-patch.mjs` | Zero-dep `postinstall` patch for `@modelcontextprotocol/sdk@1.29.0` (object schema `required: []`). `patch-package` is **devDependency only**. |
| SDK pin | `@modelcontextprotocol/sdk` locked to `1.29.0` (no caret) + `overrides` so the patch target stays stable. |
| Zod | Stays on **v3** until roadmap spike `deps-zod-v4-spike` goes go (see `codestable/compound/2026-07-12-decision-zod-v3-remain.md`). |

Security policy is **defense in depth, not a sandbox** when using full shell strings — see `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md` and remaining work in `codestable/roadmap/remaining-hardening/`.

## License

MIT
