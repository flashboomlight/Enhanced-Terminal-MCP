# Enhanced Terminal MCP Server v3.1

A powerful terminal/CLI interface for AI models via the [Model Context Protocol (MCP)](https://modelcontextprotocol.org/).

Supports **27 tools** across 7 categories: command execution, file I/O, system management, search, archives, telemetry, and session management.

## Features

- **3-Level Safety System** — strict/normal/off via `MCP_SAFETY_MODE`, hardBlock baseline always on; optional `MCP_COMMAND_POLICY=allow`
- **Path & URL Security** — traversal detection, forbidden paths, sensitive file patterns, secret scanning
- **Performance Optimized** — LRU result cache (128-entry, sliding TTL, ~32MB cap), adaptive timeouts, spawn-based streaming
- **Structured Errors** — 18 error codes with `retryable`, `suggestion`, and `param` hints for LLMs
- **Session Persistence** — cwd, env vars, and command history survive restarts (auto-saved to `.enhanced-terminal-mcp/session.json`)
- **Audit Logging** — structured JSON Lines audit log at `.enhanced-terminal-mcp/logs/audit.jsonl` (mode: `off` / `errors` / `all`)
- **Temp Resource Manager** — TTL + LRU auto-recycled temp directories for page caches and future snapshots
- **Command Output Paging** — large `execute_command` outputs can be read page-by-page via validated `cache_id` / `page` / `pageSize`
- **Rate Limiting** — token bucket (10 req/s) for command execution
- **Windows Everything Integration** — sub-10ms file search via Everything CLI

## Quick Start

```bash
# Install
npm install enhanced-terminal-mcp

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
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist` (dangerous patterns + hardBlock) or `allow` (executable allowlist + hardBlock; no shell chaining) |
| `MCP_COMMAND_ALLOW` | built-in list | Comma-separated executables/prefixes when policy is `allow` (e.g. `npm,git,node`) |
| `MCP_BATCH_RATE_MODE` | `batch` | `batch` (1 token per batch_execute) or `per_command` (1 token per command in batch) |
| `MCP_SECRETS_SCAN` | `cache` | `off` / `write` / `cache` / `strict` (strict also blocks secret-bearing read_file content) |
| `MCP_LOG_LEVEL` | `info` | Log level: debug / info / warn / error |
| `MCP_STATE_DIR` | `<project-root>/.enhanced-terminal-mcp` | State directory for session, audit logs, and temp files |
| `MCP_AUDIT_MODE` | `errors` | Audit mode: `off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | Max audit log entries to retain |
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | Max captured stdout per command before returning an explicit truncation error |
| `MCP_TEMP_TTL_MS` | `3600000` | Temp directory TTL in milliseconds |
| `MCP_MAX_TEMP_DIRS` | `100` | Max temp directories before LRU eviction |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | Auto cleanup polling interval in milliseconds |

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
| `delete_path` | Delete file or directory (requires recursive for non-empty dirs) |

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
| `pool_stats` | Process pool status (currently inactive; always empty) |

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
  └─ Structured errors (18 codes)
```

## Development

```bash
npm install
npm run build      # TypeScript compile
npm run test       # Run unit tests
npm run test:latency # E2E latency benchmarks
npm run lint       # Biome linter
npm run format     # Biome formatter
```

## Supply chain & integrity

| Artifact | Notes |
|----------|--------|
| `es_tool/es.exe` | Windows Everything CLI. Executed only after SHA-256 matches `ES_EXE_SHA256` in `src/es-integrity.ts` (`5101b3a6d9542de378e077f4b8c66c4e608d3bff088092427749b65fbb18b342`). Update binary ⇒ update constant + tests. |
| `scripts/apply-mcp-sdk-patch.mjs` | Zero-dep `postinstall` patch for `@modelcontextprotocol/sdk@1.29.0` (object schema `required: []`). `patch-package` is **devDependency only**. |
| SDK pin | `@modelcontextprotocol/sdk` locked to `1.29.0` (no caret) + `overrides` so the patch target stays stable. |
| Zod | Stays on **v3** until roadmap spike `deps-zod-v4-spike` goes go (see `codestable/compound/2026-07-12-decision-zod-v3-remain.md`). |

Security policy is **defense in depth, not a sandbox** when using full shell strings — see `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md` and remaining work in `codestable/roadmap/remaining-hardening/`.

## License

MIT
