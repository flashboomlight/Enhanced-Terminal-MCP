# Enhanced Terminal MCP Server v3.1

A powerful terminal/CLI interface for AI models via the [Model Context Protocol (MCP)](https://modelcontextprotocol.org/).

Supports **27 tools** across 7 categories: command execution, file I/O, system management, search, archives, telemetry, and session management.

## Features

- **3-Level Safety System** — strict/normal/off via `MCP_SAFETY_MODE`, 覆盖常见危险命令模式, critical process protection
- **Path & URL Security** — traversal detection, forbidden paths, sensitive file patterns, secret scanning
- **Performance Optimized** — LRU result cache (128-entry, 30s TTL), adaptive timeouts, process pool (4 pre-warmed shells), spawn-based streaming
- **Structured Errors** — 18 error codes with `retryable`, `suggestion`, and `param` hints for LLMs
- **Session Persistence** — cwd, env vars, and command history survive restarts (auto-saved to `.enhanced-terminal-mcp/session.json`)
- **Audit Logging** — structured JSON Lines audit log at `.enhanced-terminal-mcp/logs/audit.jsonl` (mode: `off` / `errors` / `all`)
- **Temp Resource Manager** — TTL + LRU auto-recycled temp directories for page caches and future snapshots
- **Command Output Paging** — large `execute_command` outputs can be read page-by-page via `page` / `pageSize`
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
| `MCP_SAFETY_MODE` | `normal` | `strict` (all destructive blocked), `normal` (confirm), `off` (no checks) |
| `MCP_LOG_LEVEL` | `info` | Log level: debug / info / warn / error |
| `MCP_STATE_DIR` | `<project-root>/.enhanced-terminal-mcp` | State directory for session, audit logs, and temp files |
| `MCP_AUDIT_MODE` | `errors` | Audit mode: `off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | Max audit log entries to retain |
| `MCP_TEMP_TTL_MS` | `3600000` | Temp directory TTL in milliseconds |
| `MCP_MAX_TEMP_DIRS` | `100` | Max temp directories before LRU eviction |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | Auto cleanup polling interval in milliseconds |

## Tool Reference

### Command Tools
| Tool | Description | Safety |
|------|-------------|--------|
| `execute_command` | Execute a single shell command with timeout, exit code, and optional output paging (`page`/`pageSize`) | destructive |
| `batch_execute` | Execute multiple commands sequentially (default) or in parallel with concurrency 4 | destructive |
| `watch_command` | Run a command for a limited duration, capturing real-time output | read_only |

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
| `copy_move` | Copy or move files/directories |
| `delete_path` | Delete file or directory (requires recursive for non-empty dirs) |

### Search Tools
| Tool | Description | Cache |
|------|-------------|-------|
| `search_files` | Pattern search with Everything on Windows, native fallback | 30s |
| `everything_search` | Ultra-fast Everything search (Windows only) | 30s |
| `grep_content` | Regex content search via PowerShell/grep/native | 30s |

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
| `compress_archive` | Zip compression |
| `extract_archive` | Zip extraction |
| `download_file` | HTTP(S) download with retry (exponential backoff) |

### Utility Tools
| Tool | Description |
|------|-------------|
| `telemetry_report` | Tool call metrics: latency, errors, cache hit rates, temp stats, audit status |
| `temp_stats` | Temp resource statistics: dirs, size, oldest/newest age, removed count |
| `cache_stats` | LRU cache statistics |
| `cache_invalidate` | Clear specific or all caches |
| `session_state` | View/modify session cwd and env (get/set_cwd/set_env/reset) |
| `pool_stats` | Shell process pool status |

### Resources
- `health://status` — JSON health check with version, metrics, cache, session, temp, and audit info
- `audit://log?limit=N` — Recent structured audit entries

### Prompts
- `usage-guide` — Tool overview (includes live session context)
- `safety-info` — Current safety configuration

## Architecture

```
MCP Client (stdio) → McpServer
  ├─ 6 tool modules (command, files, manage, search, system, archive)
  ├─ 5 utility tools (telemetry, cache, session, pool)
  ├─ wrapHandler middleware (telemetry + LRU cache)
  ├─ Security layer (path validation, dangerous patterns, secrets)
  ├─ SafeGuard (3-level safety mode)
  ├─ Rate limiting (token bucket)
  ├─ Session persistence (JSON file)
  ├─ ProcessPool (pre-warmed shells)
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

## License

MIT
