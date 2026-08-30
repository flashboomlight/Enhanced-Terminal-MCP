# Enhanced Terminal MCP Server v4.1

[![CI](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux%20%C2%B7%20macOS-lightgrey)](#linux-notes)

[中文文档 (Chinese)](./README.zh-CN.md)

A powerful terminal/CLI interface for AI models via the [Model Context Protocol (MCP)](https://modelcontextprotocol.org/).

Supports **27 tools** across 7 categories: command execution, file I/O, file management, system management, search, archives, and operational telemetry/session management.

## Contents

- [Features](#features)
- [Quick Start](#quick-start)
  - [Environment Variables](#environment-variables)
  - [Windows Default Shell (pwsh 7)](#windows-default-shell-pwsh-7)
  - [Everything Search (Windows, optional)](#everything-search-windows-optional)
- [Linux Notes](#linux-notes)
- [Tool Reference](#tool-reference)
- [Architecture](#architecture)
- [Development](#development)
- [Release verification](#release-verification)
- [Supply chain & integrity](#supply-chain--integrity)
- [Contributing](#contributing)
- [License](#license)

## Features

- **3-Level Safety System** — strict/normal/off via `MCP_SAFETY_MODE`, hardBlock baseline always on; optional `MCP_COMMAND_POLICY=allow`
- **Risk-Gated Command Confirmation** — set `MCP_COMMAND_CONFIRMATION=risk-gated` so ordinary commands run without confirmation while heavy commands (batch >5, destructive residue, performance words, long watch) ask once with the reason via MCP Elicitation
- **Path & URL Security** — traversal detection, forbidden paths, sensitive file patterns, secret scanning
- **Performance Optimized** — LRU result cache (128-entry, sliding TTL, ~32MB cap), adaptive timeouts, spawn-based streaming
- **Structured Errors** — 31 error codes with `retryable`, `suggestion`, and `param` hints for LLMs
- **Session Persistence** — cwd, env vars, and command history survive restarts (auto-saved to `.etmcp/session.json`)
- **Lazy State Directory** — `.etmcp` is created only when the first real artifact is persisted (session state, audit entry, temp/page-cache resource); startup, restore, and resource reads never create it
- **Audit Logging** — structured JSON Lines audit log at `.etmcp/logs/audit.jsonl` (mode: `off` / `errors` / `all`)
- **Temp Resource Manager** — TTL + LRU auto-recycled temp directories; the `temp` root is created only when a temp resource is actually needed
- **Command Output Paging** — large `execute_command` outputs spill to a byte-indexed page cache v2 under `.etmcp/temp` and can be read page-by-page via validated `cache_id` / `page` / `pageSize`; small outputs stay in memory and never touch disk
- **Rate Limiting** — token bucket (10 req/s) for command execution
- **Windows Everything Integration (optional)** — sub-10ms file search via the Everything CLI you install yourself, resolved from `ENHANCED_TERMINAL_ES_PATH` or `<state-dir>/tools/es.exe`; Everything is not distributed with this package, and `search_files` falls back to native search when unavailable
- **Optional fd Search Engine (Linux/macOS)** — `search_files` accelerates via `fd`/`fdfind` on PATH or an explicit `ENHANCED_TERMINAL_FD_PATH` (fail-closed); falls back to built-in native search silently when unavailable

## Quick Start

### npm consumer

Install the package in the consumer project once it is published to npm, then use its bin entry. The npm package does not include setup.bat, the source checkout, bundled pwsh, or any Everything components. Installation must allow lifecycle scripts because postinstall applies the pinned MCP SDK compatibility patch.

```bash
# Global installation
npm install --global enhanced-terminal-mcp

# Or project-local installation
npm install enhanced-terminal-mcp
```

MCP configuration for a global installation:

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "enhanced-terminal-mcp"
    }
  }
}
```

For a project-local installation, use the npm runner explicitly:

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "npx",
      "args": ["--yes", "enhanced-terminal-mcp@4.1.0"]
    }
  }
}
```

The npm consumer path never downloads pwsh at install or runtime. On Windows it uses an explicit MCP_POWERSHELL_PATH, a local pwsh on PATH, or the existing Windows PowerShell 5.1 fallback according to the shell resolver.

### Source checkout (any platform)

Clone and build from the repository root:

```bash
git clone https://github.com/flashboomlight/Enhanced-Terminal-MCP.git
cd Enhanced-Terminal-MCP
pnpm install        # or: npm install
pnpm run build      # or: npm run build
```

> The dev toolchain requires Node.js 22.13+ (required by the pinned pnpm 11.21.0). The runtime (npm package) itself remains compatible with Node.js 20+.

On Windows, `setup.bat` is an alternative bootstrap: it installs with the pinned pnpm version, builds `build/index.js`, and then runs the explicit fixed-version pwsh bootstrap. Use `setup.bat --no-pwsh` to skip that optional download, and add `--non-interactive` for CI or automation. On Linux/macOS the plain install + build above is the whole setup — no pwsh is needed.

Point your MCP client at the built entry with an absolute path:

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/Enhanced-Terminal-MCP/build/index.js"]
    }
  }
}
```

The source checkout and npm consumer paths are intentionally separate: setup.bat is not an npm package entry point, and npm install is not a replacement for the source bootstrap.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SAFETY_MODE` | `normal` | `strict` (all destructive blocked), `normal` (confirm destructive tools), `off` (no checks; hardBlock still on) |
| `MCP_COMMAND_CONFIRMATION` | `all` | `all` (confirm every command tool call in normal mode — default, unchanged behavior) or `risk-gated` (ordinary commands run without confirmation; heavy commands — batch >5, destructive residue, performance words, watch >60s — require one Elicitation confirmation carrying the risk reason; works in `off` too, only ordinary is exempted). Invalid values fall back to `all` with a startup warning. `strict` still blocks command tools regardless. |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist` (dangerous patterns + hardBlock) or `allow` (executable allowlist + hardBlock; no shell chaining) |
| `MCP_COMMAND_ALLOW` | built-in list | Comma-separated executables/prefixes when policy is `allow` (e.g. `npm,git,node`) |
| `MCP_BATCH_RATE_MODE` | `batch` | `batch` (1 token per batch_execute) or `per_command` (1 token per command in batch) |
| `MCP_SECRETS_SCAN` | `cache` | `off` / `write` / `cache` / `strict` (strict also blocks secret-bearing read_file content and fails closed when content exceeds the 4 MiB scanner capacity) |
| `MCP_ENV_VALUE_MODE` | `allowlist` | `environment_vars` value display: `allowlist` (values only for built-in non-sensitive keys + `MCP_ENV_VALUE_ALLOWLIST`), `full` (all non-sensitive values), `keys` (values always masked). Sensitive keywords are masked in every mode; displayed values pass the secret redactor; results are never cached. |
| `MCP_ENV_VALUE_ALLOWLIST` | — | Comma-separated extra env key names (case-insensitive, exact match) whose values `environment_vars` may display in `allowlist` mode |
| `MCP_SESSION_PERSIST_ENV_VALUES` | `0` | Set to `1` to persist session env values to `session.json`. Off by default: only env keys are persisted. Deny-listed keys (`PATH`, `NODE_OPTIONS`, …, matched case-insensitively) and sensitive keys are never persisted. Command history is persisted redacted either way. |
| `MCP_LOG_LEVEL` | `info` | Log level: debug / info / warn / error |
| `MCP_SHELL` | `pwsh` | Windows shell mode: `pwsh` (PowerShell 7, recommended), `powershell` (Windows PowerShell 5.1), `cmd` (legacy cmd.exe escape hatch). Unix is unaffected. |
| `MCP_POWERSHELL_PATH` | — | Explicit path to a pwsh 7 / PowerShell executable. Takes highest priority; invalid path is a hard error (no silent fallback). |
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | State directory for session, audit logs, and temp files. With the default root, legacy `<project-root>/.enhanced-terminal-mcp` `session.json`/`logs/audit.jsonl` are migrated; `temp` and unknown files are never migrated. Setting this override disables automatic legacy migration. |
| `MCP_AUDIT_MODE` | `errors` | Audit mode: `off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | Max audit log entries retained via entry-count compaction (also the `recent()` read window) |
| `MCP_AUDIT_QUEUE_MAX_ENTRIES` | `2000` | Max entries in the in-memory audit queue; overflow drops the oldest and increments the observable `dropped` counter |
| `MCP_AUDIT_QUEUE_MAX_BYTES` | `4194304` | Byte cap on the in-memory audit queue (4 MiB); overflow drops the oldest and increments `dropped` |
| `MCP_AUDIT_MAX_ENTRY_BYTES` | `65536` | Byte cap per serialized audit entry (64 KiB); oversized entries keep an `{truncated: true}` skeleton instead of being dropped |
| `MCP_AUDIT_MAX_FILE_BYTES` | `8388608` | Audit file size cap (8 MiB); the file rotates to `audit.jsonl.1` after a successful write that crosses the limit |
| `MCP_AUDIT_MAX_ROTATIONS` | `1` | Rotated audit generations to keep (`audit.jsonl.1` … `.N`); `0` deletes the rotated file instead |
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | Max captured stdout bytes retained per command before the result is flagged `truncated` and spilled to the page cache; see `MCP_COMMAND_MEMORY_OUTPUT_BYTES` for the in-memory spill threshold |
| `MCP_TEMP_TTL_MS` | `3600000` | Temp directory TTL in milliseconds |
| `MCP_MAX_TEMP_DIRS` | `100` | Max temp directories before LRU eviction |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | Auto cleanup polling interval in milliseconds |
| `MCP_COMMAND_MEMORY_OUTPUT_BYTES` | `1048576` | In-memory retention threshold per command; output beyond this spills to the page cache (`paged=true`) |
| `MCP_COMMAND_MAX_STDERR_BYTES` | `1048576` | Max stderr bytes retained per command |
| `MCP_TEMP_MAX_TOTAL_BYTES` | `1073741824` | Max total temp bytes before LRU eviction kicks in. Outstanding reservations are shared across server processes via `<state-dir>/temp/.quota.json` (stale entries of dead processes are recycled automatically); coordination files (`.quota.json`, `.temp.lock`) do not count toward the payload budget |
| `ENHANCED_TERMINAL_ES_PATH` | — | Explicit path to the Everything CLI (`es.exe`) you installed yourself. Takes priority over `<state-dir>/tools/es.exe`; must be an existing regular file, and an invalid explicit path fails closed (no silent fallback, no version lock). `search_files` falls back only when the implicit state binary is unavailable; `everything_search` returns structured installation detail. Everything is not distributed with this package. |
| `ENHANCED_TERMINAL_FD_PATH` | — | Explicit path to an `fd` executable for non-Windows `search_files` acceleration. Must be absolute + a file + pass a `--version` probe; an invalid explicit path fails closed (`VALIDATION_ERROR`, no silent fallback). When unset, `fd` / `fdfind` are probed on `PATH` once per process; if neither exists, native search is used silently. |
| `MCP_SSRF_MODE` | surface default | `deny-private` / `allow-private`. Unset: `download_file` uses `deny-private` (loopback/private/link-local/metadata targets blocked, incl. `169.254.169.254`), `network_info` uses `allow-private` (diagnostics unaffected). Explicit values apply to both surfaces. Forbidden addresses (unspecified/multicast/reserved) are always blocked. Proxy env vars are never used. |
| `MCP_DOWNLOAD_MAX_BYTES` | `104857600` | Max bytes actually received per download (100 MiB); shared across retries. Exceeding aborts the stream and removes the staging file. |
| `MCP_DOWNLOAD_TIMEOUT_MS` | `120000` | Absolute download deadline (covers the whole redirect chain and retries). |
| `MCP_DOWNLOAD_MAX_REDIRECTS` | `5` | Max redirect hops; every hop is re-resolved and re-validated against SSRF policy. |
| `MCP_ARCHIVE_MAX_MEMBERS` | `10000` | Max archive members for extraction manifests and compress source pre-walks. |
| `MCP_ARCHIVE_MAX_MEMBER_BYTES` | `268435456` | Max expanded bytes per archive member (256 MiB); enforced against the manifest AND the actual extracted stream. |
| `MCP_ARCHIVE_MAX_EXPANDED_BYTES` | `1073741824` | Max total expanded bytes per extraction (1 GiB); enforced twice (manifest pre-check + live counting). |
| `MCP_ARCHIVE_MAX_INPUT_BYTES` | `1073741824` | Max total source bytes for `compress_archive` (1 GiB); rejected before spawning the compressor. |
| `MCP_ARCHIVE_MAX_RATIO` | `200` | Max expanded/compressed ratio, applied only to members expanding beyond 64 MiB (zip bomb guard). |
| `MCP_RESPONSE_MAX_BYTES` | `2097152` | Hard cap on the serialized tool response (text content + structured content, UTF-8 bytes). Oversized successful responses are downgraded to a `RESOURCE_LIMIT` error envelope; invalid values fall back to the default with a warning. There is no unlimited setting. |
| `ENHANCED_TERMINAL_DISABLE_FILE_INFO` | — | Set to `1` to disable the `file_info` tool; the tool surface drops from 27 to 26 tools. Banner, `health://status` (`tools.enabled/disabled`) and the usage-guide prompt report the same enabled count as `tools/list`. |

### Windows Default Shell (pwsh 7)

On Windows, command tools resolve a shell once per process, in this order:

1. `MCP_POWERSHELL_PATH` (explicit, fail-closed)
2. Bundled portable pwsh 7 at `tools/pwsh/pwsh.exe` (installed by `setup.bat`, fixed version + SHA256 verified)
3. pwsh 7 found on `PATH`
4. Windows PowerShell 5.1 fallback (logs a warning)

pwsh 7 and Windows PowerShell 5.1 use the invocation-layer UTF-8 preamble; cmd keeps `chcp 65001`. Use `MCP_SHELL=cmd` to restore the legacy cmd.exe behavior. The cmd/powershell inline non-ASCII mojibake issue was fixed in the M2 output-decoding layer (`src/command-output.ts`). Changing shells or installing pwsh requires a server restart (resolution is cached for the process lifetime).

### Everything Search (Windows, optional)

Optional integration with [Everything](https://www.voidtools.com/) by voidtools for near-instant file-name search on Windows. **Everything is not distributed with Enhanced Terminal MCP** — neither in the repository nor in the npm package. To enable it:

1. Install Everything from voidtools.
2. Obtain the Everything CLI (`es.exe`) from the same source.
3. Point the server at your copy: set `ENHANCED_TERMINAL_ES_PATH` to the absolute path of `es.exe`, or place the file at `<state-dir>/tools/es.exe`.
4. A successful resolution is cached for the process lifetime; a failed one is retried on the next call, so installing `es.exe` later needs no restart.

The server only validates that the configured path exists and is a regular file — nothing is downloaded, nothing is executed for probing, and no specific `es.exe` version is pinned. Without Everything, `search_files` automatically uses native search (or `fd` on Linux/macOS), and `everything_search` returns structured installation detail instead of an empty result.

## Linux Notes

- **Shell**: command execution uses `/bin/sh -c`. The pwsh/PowerShell resolution chain (`MCP_SHELL`, `MCP_POWERSHELL_PATH`, bundled `tools/pwsh`) is Windows-only and needs nothing on Linux.
- **Archive tools**: `compress_archive` / `extract_archive` shell out to the system `zip` / `unzip` binaries — install them via your package manager (e.g. `apt-get install -y zip unzip`).
- **Search**: `everything_search` is Windows-only; on Linux/macOS `search_files` uses the `fd` engine when available (`fd` or `fdfind` on `PATH`, or an explicit `ENHANCED_TERMINAL_FD_PATH`), and otherwise falls back to the built-in native recursive search (same partial-result contract, slower on large trees). Install via your package manager (e.g. `apt-get install -y fd-find`) for a large speedup on big trees.
- Everything else — the safety layers, session persistence, audit logging, page cache, rate limiting — is platform-neutral, and the full environment-variable table above applies unchanged.

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

For interactive personal-agent use, the recommended profile is `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`: ordinary commands execute fluently while heavy commands stop once with the risk reason. Filesystem-boundary enforcement belongs to the host sandbox per the MCP specification; this server deliberately keeps no directory allowlist (the previous `MCP_CONFIRMATION_MODE=headless` / `MCP_ALLOWED_ROOTS` mechanism was removed in v4.0.0).

### Search Tools
| Tool | Description | Cache |
|------|-------------|-------|
| `search_files` | Pattern search: Everything on Windows, fd on Linux/macOS when available, native fallback otherwise | 30s |
| `everything_search` | Ultra-fast Everything search (Windows only) | — |
| `grep_content` | Regex content search via PowerShell/grep/native with global `max_results` | 30s |

Search and `list_directory` results carry a partial-result contract: `complete` (false when traversal/read errors were skipped), `warnings` (bounded structured warning codes), and `truncated` (budget reached). Partial (`complete=false`) results are never cached.

### System Tools
| Tool | Description |
|------|-------------|
| `get_system_info` | OS, CPU, memory, disk, GPU details (60s cache) |
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
- `health://status` — JSON health check with version, metrics, cache, session, temp, and audit info. `status` is `healthy` / `degraded` / `failed` (never a fixed `ok`), aggregated from four components (`components.audit` writer failures/queue drops, `components.temp` capacity rejections/cleanup lock failures, `components.process` child-termination failures, `components.session` persistence failures)
- `audit://log` — Recent structured audit entries (default limit: 50)
- `audit://log?limit=N` — Recent structured audit entries with a requested limit (clamped to 1–1000)

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
  └─ Structured errors (31 codes)
```

## Development

```bash
pnpm install
pnpm run build          # clean build/ and compile TypeScript
pnpm exec tsc --noEmit  # Type-check without emitting
pnpm test               # Run unit tests
pnpm run test:conformance   # Real stdio MCP protocol checks
pnpm run test:hostile-input # Bounded/policy hostile-input corpus
pnpm run test:platform-smoke # Minimal cross-platform server smoke
pnpm run test:latency   # E2E latency benchmarks
pnpm run lint           # Biome linter
pnpm run format         # Biome formatter
pnpm run gate            # Canonical release gate (all stages blocking)
pnpm run gate -- --ci   # Same gate; latency is explicit advisory in CI
```

Development uses pnpm `11.21.0` (which requires Node.js 22.13+). pnpm can reuse a machine-configured shared content store; the store path is machine-local configuration (inspect it with `pnpm store path`), not part of the repository contract, and must not be written into repository files, package metadata, lockfiles, or published artifacts. Each MCP project keeps its own `node_modules`, virtual store, and lockfile. Do not share a runtime `node_modules` directory or use `NODE_PATH` between projects. The published package remains installable by npm as shown in Quick Start.

## Release verification

Maintainers should run `pnpm run gate` before publishing. It is the single canonical release gate and runs, in order: clean build, type-check, lint, the full test suite, main/tools coverage floors, latency, production dependency audit, the real npm tarball verifier, and a clean consumer check. The stages can also be run individually with the commands below; the verifier does not publish, upload, sign, or replace CI provenance.

```bash
pnpm run audit:prod
pnpm run build
node scripts/verify-package.mjs
```

verify-package.mjs and verify-clean-consumer.mjs are source-maintenance tools and are not shipped in the npm package. The clean consumer check runs against the actual tarball:

```bash
node scripts/verify-clean-consumer.mjs <path-to-tarball>
```

The verifier JSON output, pnpm audit result, lockfile, SBOM, and CI-generated provenance must be kept together as the same release evidence. A local SHA-256 alone only proves the tarball's content digest; it is not a signature or provenance.

## Supply chain & integrity

| Artifact | Notes |
|----------|--------|
| `scripts/apply-mcp-sdk-patch.mjs` | Zero-dep `postinstall` patch for `@modelcontextprotocol/sdk@1.29.0`; it resolves only the package-owned SDK and fails closed on version, layout, or pattern drift. `patch-package` is **devDependency only**. |
| SDK pin | `@modelcontextprotocol/sdk` remains exactly `1.29.0` for wire/API compatibility; its patched transitive dependency versions are frozen in `pnpm-lock.yaml`. |
| Package verifier | `scripts/verify-package.mjs` checks the actual tarball, package files, entry point, source maps, forbidden local assets and SHA-256. |
| Zod | Stays on **v3** by recorded decision (2026-07-12) until the zod v4 migration spike concludes go. |

Third-party attribution and distribution boundaries (MCP SDK compatibility patch, Zod, Everything, pwsh bootstrap) are recorded in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md), which also ships in the npm package.

Security policy is **defense in depth, not a sandbox** when using full shell strings — see [`SECURITY.md`](./SECURITY.md) for the threat model, hardBlock floor, dependency policy, and vulnerability reporting. The hardening roadmaps (`2026-07-12-remaining-hardening`, `2026-08-28-production-hardening`) are closed; see [`CHANGELOG.md`](./CHANGELOG.md) for the current release state.

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](./CONTRIBUTING.md) first (note the security invariants before touching `src/security.ts` or `src/safeguard.ts`), follow the [Code of Conduct](./CODE_OF_CONDUCT.md), and report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) — third-party attributions are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), and notable changes in [CHANGELOG.md](./CHANGELOG.md).
