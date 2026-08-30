# Enhanced Terminal MCP Server v4.1

[![CI](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/flashboomlight/Enhanced-Terminal-MCP/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%3E%3D%2020-brightgreen)](./package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Linux%20%C2%B7%20macOS-lightgrey)](#platform-notes)

[中文文档 (Chinese)](./README.zh-CN.md)

A terminal/CLI interface for AI models via the [Model Context Protocol (MCP)](https://modelcontextprotocol.org/): one stdio server that gives your AI assistant **27 tools** for command execution, file I/O, file management, search, system management, archives, and operational telemetry — with a layered safety model on top.

## What you can do

- **Run shell commands from the AI assistant** — single commands, batches, or timed watches; long outputs spill to a page cache the model can page through without re-running.
- **Read, write, and organize local files** — paged reads, guarded writes with secret scanning, copy/move/delete behind per-action confirmation.
- **Find files fast** — sub-10ms name search on Windows via Everything (you bring `es.exe`), `fd` acceleration on Linux/macOS, plus regex content search.
- **Inspect and manage the system** — processes, network checks, environment variables (with sensitive values masked).
- **Work with archives and downloads** — zip/unzip and HTTP(S) downloads guarded by size budgets and SSRF policy.
- **See what the server did** — structured audit log, truthful health status, and per-tool telemetry.

## Contents

- [What you can do](#what-you-can-do)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Tools](#tools)
- [Safety & confirmation](#safety--confirmation)
- [Platform Notes](#platform-notes)
- [Troubleshooting](#troubleshooting)
- [For maintainers](#for-maintainers)
- [Contributing](#contributing)
- [License](#license)

Detailed references live in [`docs/`](./docs/): [Installation & client setup](./docs/installation.md) · [Configuration reference](./docs/configuration.md) · [Tool reference](./docs/tools.md) · [Safety model & profiles](./docs/safety.md) · [Troubleshooting](./docs/troubleshooting.md)

## Quick Start

### 1. Install from source

The npm package is **not yet published** — a source checkout is the installation method today:

```bash
git clone https://github.com/flashboomlight/Enhanced-Terminal-MCP.git
cd Enhanced-Terminal-MCP
pnpm install        # or: npm install
pnpm run build      # or: npm run build
```

> Building requires Node.js 22.13+ (pinned pnpm 11.21.0). The built server itself runs on Node.js 20+.

On Windows, `setup.bat` is an alternative bootstrap that also fetches a fixed-version, SHA256-verified portable pwsh 7 into `tools/pwsh` (`--no-pwsh` to skip, `--non-interactive` for CI). On Linux/macOS the install + build above is the whole setup. The server never downloads anything at runtime.

### 2. Point your MCP client at it

```json
{
  "mcpServers": {
    "enhanced-terminal-mcp": {
      "command": "node",
      "args": ["D:\\absolute\\path\\to\\Enhanced-Terminal-MCP\\build\\index.js"],
      "env": {
        "MCP_SAFETY_MODE": "off",
        "MCP_COMMAND_CONFIRMATION": "risk-gated"
      }
    }
  }
}
```

Where this JSON goes depends on your client — Claude Desktop, Cursor, VS Code, and Cherry Studio each have their own config location; see [Installation & client setup](./docs/installation.md) for the per-client table, the optional npm layout (planned), and how to verify the install (27 tools in `tools/list`, `health://status` reads `healthy`).

The `env` block above is the recommended personal-use profile; every variable is optional and documented in [Configuration](#configuration).

## Configuration

All options are environment variables on the server process (the client's `env` block). The common ones:

| Variable | Default | What it controls |
|----------|---------|------------------|
| `MCP_SAFETY_MODE` | `normal` | `strict` / `normal` / `off` gating of guarded tools |
| `MCP_COMMAND_CONFIRMATION` | `all` | `all` confirms every command; `risk-gated` lets ordinary commands run and confirms heavy ones once |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist` pattern screening or `allow` executable allowlist |
| `MCP_SHELL` | `pwsh` | Windows shell: `pwsh` / `powershell` / `cmd` (Unix always `/bin/sh -c`) |
| `MCP_POWERSHELL_PATH` | — | Explicit pwsh/PowerShell path (highest priority, fail-closed) |
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | Where session, audit log, page cache, and temp files live |
| `MCP_AUDIT_MODE` | `errors` | `off` / `errors` / `all` audit logging |
| `MCP_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

The full reference — 40 variables grouped by topic (safety, shell, state/audit, output/temp, search engines, download/archive), plus copy-paste profiles — is in [docs/configuration.md](./docs/configuration.md).

## Tools

27 tools across 7 categories (26 when `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`). One-line summaries below; **parameters, defaults, and the output contracts are in [docs/tools.md](./docs/tools.md)**.

### Command Tools
| Tool | Description | Safety |
|------|-------------|--------|
| `execute_command` | Execute a shell command, or read cached paged output via `cache_id` (`page`/`pageSize`) | destructive |
| `batch_execute` | Execute multiple commands sequentially (default) or in parallel with concurrency 4 | destructive |
| `watch_command` | Run a command for a limited duration, capturing output and failing on non-zero exit | destructive |

Large outputs spill to a page cache instead of flooding the context:

```
execute_command({ command: "pnpm test" })        → paged: true, cache_id: "…", page 1 of 12
execute_command({ cache_id: "…", page: 2 })       → page 2, without re-running the tests
```

### File Tools
| Tool | Description | Cache |
|------|-------------|-------|
| `read_file` | Read file with paging (offset/lines), encoding auto-detection | 30s |
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
- `health://status` — JSON health check: `healthy` / `degraded` / `failed`, aggregated from four components (audit writer, temp capacity, process supervisor, session persistence). Readable directly; it is registered as a template and does not appear in `resources/list`.
- `audit://log` — Recent structured audit entries (default limit: 50)
- `audit://log?limit=N` — Recent structured audit entries with a requested limit (clamped to 1–1000)

### Prompts
- `usage-guide` — Tool overview (includes live session context)
- `safety-info` — Current safety configuration

## Safety & confirmation

Two layers, always in effect:

- **Safety mode** (`MCP_SAFETY_MODE`): `strict` blocks the ten guarded tools (all command tools, writes, delete, copy/move, archive, download, kill); `normal` confirms each guarded action via MCP Elicitation; `off` skips confirmations. A fixed **hardBlock floor** blocks destructive command patterns in every mode, including `off` — it cannot be disabled.
- **Command confirmation** (`MCP_COMMAND_CONFIRMATION`): `all` confirms every command call; `risk-gated` lets ordinary commands run immediately and confirms heavy commands (batch >5, destructive residue, performance words, watch >60s) once, with the reason attached.

For interactive personal-agent use, the recommended profile is `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`: ordinary commands execute fluently while heavy commands stop once with the risk reason. CI and locked-down profiles (including the `MCP_COMMAND_POLICY=allow` executable allowlist) are in [docs/safety.md](./docs/safety.md), along with the trust boundaries — the model is **defense in depth, not a sandbox**; filesystem-boundary enforcement belongs to the host sandbox per the MCP specification.

## Platform Notes

### Windows: shell resolution

Command tools resolve a shell once per process, in this order:

1. `MCP_POWERSHELL_PATH` (explicit, fail-closed)
2. Bundled portable pwsh 7 at `tools/pwsh/pwsh.exe` (installed by `setup.bat`, fixed version + SHA256 verified)
3. pwsh 7 found on `PATH`
4. Windows PowerShell 5.1 fallback (logs a warning)

pwsh 7 and Windows PowerShell 5.1 use the invocation-layer UTF-8 preamble; cmd keeps `chcp 65001`. Use `MCP_SHELL=cmd` to restore the legacy cmd.exe behavior. Changing shells or installing pwsh requires a server restart (resolution is cached for the process lifetime).

### Windows: Everything search (optional)

Optional integration with [Everything](https://www.voidtools.com/) by voidtools for near-instant file-name search on Windows. **Everything is not distributed with Enhanced Terminal MCP** — neither in the repository nor in the npm package. To enable it:

1. Install Everything from voidtools.
2. Obtain the Everything CLI (`es.exe`) from the same source.
3. Point the server at your copy: set `ENHANCED_TERMINAL_ES_PATH` to the absolute path of `es.exe`, or place the file at `<state-dir>/tools/es.exe`.
4. A successful resolution is cached for the process lifetime; a failed one is retried on the next call, so installing `es.exe` later needs no restart.

The server only validates that the configured path exists and is a regular file — nothing is downloaded, nothing is executed for probing, and no specific `es.exe` version is pinned. Without Everything, `search_files` automatically uses native search (or `fd` on Linux/macOS), and `everything_search` returns structured installation detail instead of an empty result.

### Linux / macOS

- **Shell**: command execution uses `/bin/sh -c`. The pwsh/PowerShell resolution chain (`MCP_SHELL`, `MCP_POWERSHELL_PATH`, bundled `tools/pwsh`) is Windows-only and needs nothing on Linux.
- **Archive tools**: `compress_archive` / `extract_archive` shell out to the system `zip` / `unzip` binaries — install them via your package manager (e.g. `apt-get install -y zip unzip`).
- **Search**: `everything_search` is Windows-only; on Linux/macOS `search_files` uses the `fd` engine when available (`fd` or `fdfind` on `PATH`, or an explicit `ENHANCED_TERMINAL_FD_PATH`), and otherwise falls back to the built-in native recursive search (same partial-result contract, slower on large trees). Install via your package manager (e.g. `apt-get install -y fd-find`) for a large speedup on big trees.
- Everything else — the safety layers, session persistence, audit logging, page cache, rate limiting — is platform-neutral, and the full [configuration reference](./docs/configuration.md) applies unchanged.

## Troubleshooting

- **Installed pwsh but 5.1 is still used?** Shell resolution is cached per process — restart the server.
- **`everything_search` unavailable / slow search on Windows?** Everything (`es.exe`) is not bundled; set `ENHANCED_TERMINAL_ES_PATH` or drop it at `<state-dir>/tools/es.exe`.
- **26 tools instead of 27?** `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` is set.
- **Archive tools fail on Linux?** Install the system `zip` / `unzip` binaries.

More (state directory location, audit/logging, hardBlock blocks, fd setup): [docs/troubleshooting.md](./docs/troubleshooting.md).

## For maintainers

<details>
<summary><b>Architecture</b></summary>

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
</details>

### Development

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

Development uses pnpm `11.21.0` (which requires Node.js 22.13+). pnpm can reuse a machine-configured shared content store; the store path is machine-local configuration (inspect it with `pnpm store path`), not part of the repository contract, and must not be written into repository files, package metadata, lockfiles, or published artifacts. Each MCP project keeps its own `node_modules`, virtual store, and lockfile. Do not share a runtime `node_modules` directory or use `NODE_PATH` between projects.

### Release verification

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

### Supply chain & integrity

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
