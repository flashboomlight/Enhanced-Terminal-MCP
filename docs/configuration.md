# Configuration Reference

Every runtime option is an environment variable set on the MCP server process (in your client's `env` block, or the shell that launches it). Invalid enum values fall back to the default with a startup warning; there are no hidden config files.

For the concept-level explanation of the safety-related variables, see [Safety Model & Profiles](./safety.md). For a minimal setup, the README's [Quick Start](../README.md#quick-start) needs none of these — every variable is optional.

## Safety & confirmation

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SAFETY_MODE` | `normal` | `strict` (all destructive blocked), `normal` (confirm destructive tools), `off` (no checks; hardBlock still on) |
| `MCP_COMMAND_CONFIRMATION` | `all` | `all` (confirm every command tool call in normal mode — default, unchanged behavior) or `risk-gated` (ordinary commands run without confirmation; heavy commands — batch >5, destructive residue, performance words, watch >60s — require one Elicitation confirmation carrying the risk reason; works in `off` too, only ordinary is exempted). Invalid values fall back to `all` with a startup warning. `strict` still blocks command tools regardless. |
| `MCP_COMMAND_POLICY` | `blocklist` | `blocklist` (dangerous patterns + hardBlock) or `allow` (executable allowlist + hardBlock; no shell chaining) |
| `MCP_COMMAND_ALLOW` | built-in list | Comma-separated executables/prefixes when policy is `allow` (e.g. `npm,git,node`) |
| `MCP_SECRETS_SCAN` | `cache` | `off` / `write` / `cache` / `strict` (strict also blocks secret-bearing read_file content and fails closed when content exceeds the 4 MiB scanner capacity) |

## Shell (Windows)

Unix command execution always uses `/bin/sh -c`; these variables only affect Windows. Resolution is cached per process — changing shells or installing pwsh requires a server restart.

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SHELL` | `pwsh` | Windows shell mode: `pwsh` (PowerShell 7, recommended), `powershell` (Windows PowerShell 5.1), `cmd` (legacy cmd.exe escape hatch). Unix is unaffected. |
| `MCP_POWERSHELL_PATH` | — | Explicit path to a pwsh 7 / PowerShell executable. Takes highest priority; invalid path is a hard error (no silent fallback). |

## State, session & logging

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_STATE_DIR` | `<project-root>/.etmcp` | State directory for session, audit logs, and temp files. With the default root, legacy `<project-root>/.enhanced-terminal-mcp` `session.json`/`logs/audit.jsonl` are migrated; `temp` and unknown files are never migrated. Setting this override disables automatic legacy migration. |
| `MCP_SESSION_PERSIST_ENV_VALUES` | `0` | Set to `1` to persist session env values to `session.json`. Off by default: only env keys are persisted. Deny-listed keys (`PATH`, `NODE_OPTIONS`, …, matched case-insensitively) and sensitive keys are never persisted. Command history is persisted redacted either way. |
| `MCP_LOG_LEVEL` | `info` | Log level: debug / info / warn / error |
| `MCP_ENV_VALUE_MODE` | `allowlist` | `environment_vars` value display: `allowlist` (values only for built-in non-sensitive keys + `MCP_ENV_VALUE_ALLOWLIST`), `full` (all non-sensitive values), `keys` (values always masked). Sensitive keywords are masked in every mode; displayed values pass the secret redactor; results are never cached. |
| `MCP_ENV_VALUE_ALLOWLIST` | — | Comma-separated extra env key names (case-insensitive, exact match) whose values `environment_vars` may display in `allowlist` mode |

## Audit log

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_AUDIT_MODE` | `errors` | Audit mode: `off` / `errors` / `all` |
| `MCP_AUDIT_MAX_ENTRIES` | `10000` | Max audit log entries retained via entry-count compaction (also the `recent()` read window) |
| `MCP_AUDIT_QUEUE_MAX_ENTRIES` | `2000` | Max entries in the in-memory audit queue; overflow drops the oldest and increments the observable `dropped` counter |
| `MCP_AUDIT_QUEUE_MAX_BYTES` | `4194304` | Byte cap on the in-memory audit queue (4 MiB); overflow drops the oldest and increments `dropped` |
| `MCP_AUDIT_MAX_ENTRY_BYTES` | `65536` | Byte cap per serialized audit entry (64 KiB); oversized entries keep an `{truncated: true}` skeleton instead of being dropped |
| `MCP_AUDIT_MAX_FILE_BYTES` | `8388608` | Audit file size cap (8 MiB); the file rotates to `audit.jsonl.1` after a successful write that crosses the limit |
| `MCP_AUDIT_MAX_ROTATIONS` | `1` | Rotated audit generations to keep (`audit.jsonl.1` … `.N`); `0` deletes the rotated file instead |

## Command output & temp

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_COMMAND_MAX_OUTPUT_BYTES` | `52428800` | Max captured stdout bytes retained per command before the result is flagged `truncated` and spilled to the page cache; see `MCP_COMMAND_MEMORY_OUTPUT_BYTES` for the in-memory spill threshold |
| `MCP_COMMAND_MEMORY_OUTPUT_BYTES` | `1048576` | In-memory retention threshold per command; output beyond this spills to the page cache (`paged=true`) |
| `MCP_COMMAND_MAX_STDERR_BYTES` | `1048576` | Max stderr bytes retained per command |
| `MCP_BATCH_RATE_MODE` | `batch` | `batch` (1 token per batch_execute) or `per_command` (1 token per command in batch) |
| `MCP_TEMP_TTL_MS` | `3600000` | Temp directory TTL in milliseconds |
| `MCP_MAX_TEMP_DIRS` | `100` | Max temp directories before LRU eviction |
| `MCP_TEMP_CLEANUP_INTERVAL_MS` | `300000` | Auto cleanup polling interval in milliseconds |
| `MCP_TEMP_MAX_TOTAL_BYTES` | `1073741824` | Max total temp bytes before LRU eviction kicks in. Outstanding reservations are shared across server processes via `<state-dir>/temp/.quota.json` (stale entries of dead processes are recycled automatically); coordination files (`.quota.json`, `.temp.lock`) do not count toward the payload budget |

## Search engines

Both engines are optional and never downloaded at runtime. See the README's [Platform Notes](../README.md#platform-notes) for the full resolution chains.

| Variable | Default | Description |
|----------|---------|-------------|
| `ENHANCED_TERMINAL_ES_PATH` | — | Explicit path to the Everything CLI (`es.exe`) you installed yourself. Takes priority over `<state-dir>/tools/es.exe`; must be an existing regular file, and an invalid explicit path fails closed (no silent fallback, no version lock). `search_files` falls back only when the implicit state binary is unavailable; `everything_search` returns structured installation detail. Everything is not distributed with this package. |
| `ENHANCED_TERMINAL_FD_PATH` | — | Explicit path to an `fd` executable for non-Windows `search_files` acceleration. Must be absolute + a file + pass a `--version` probe; an invalid explicit path fails closed (`VALIDATION_ERROR`, no silent fallback). When unset, `fd` / `fdfind` are probed on `PATH` once per process; if neither exists, native search is used silently. |

## Download & archive

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_SSRF_MODE` | surface default | `deny-private` / `allow-private`. Unset: `download_file` uses `deny-private` (loopback/private/link-local/metadata targets blocked, incl. `169.254.169.254`), `network_info` uses `allow-private` (diagnostics unaffected). Explicit values apply to both surfaces. Forbidden addresses (unspecified/multicast/reserved) are always blocked. Proxy env vars are never used. |
| `MCP_DOWNLOAD_MAX_BYTES` | `104857600` | Max bytes actually received per download (100 MiB); shared across retries. Exceeding aborts the stream and removes the staging file. |
| `MCP_DOWNLOAD_TIMEOUT_MS` | `120000` | Absolute download deadline (covers the whole redirect chain and retries). |
| `MCP_DOWNLOAD_MAX_REDIRECTS` | `5` | Max redirect hops; every hop is re-resolved and re-validated against SSRF policy. |
| `MCP_ARCHIVE_MAX_MEMBERS` | `10000` | Max archive members for extraction manifests and compress source pre-walks. |
| `MCP_ARCHIVE_MAX_MEMBER_BYTES` | `268435456` | Max expanded bytes per archive member (256 MiB); enforced against the manifest AND the actual extracted stream. |
| `MCP_ARCHIVE_MAX_EXPANDED_BYTES` | `1073741824` | Max total expanded bytes per extraction (1 GiB); enforced twice (manifest pre-check + live counting). |
| `MCP_ARCHIVE_MAX_INPUT_BYTES` | `1073741824` | Max total source bytes for `compress_archive` (1 GiB); rejected before spawning the compressor. |
| `MCP_ARCHIVE_MAX_RATIO` | `200` | Max expanded/compressed ratio, applied only to members expanding beyond 64 MiB (zip bomb guard). |

## Response & tool surface

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_RESPONSE_MAX_BYTES` | `2097152` | Hard cap on the serialized tool response (text content + structured content, UTF-8 bytes). Oversized successful responses are downgraded to a `RESOURCE_LIMIT` error envelope; invalid values fall back to the default with a warning. There is no unlimited setting. |
| `ENHANCED_TERMINAL_DISABLE_FILE_INFO` | — | Set to `1` to disable the `file_info` tool; the tool surface drops from 27 to 26 tools. Banner, `health://status` (`tools.enabled/disabled`) and the usage-guide prompt report the same enabled count as `tools/list`. |

## Profiles

Copy-paste `env` blocks for common scenarios. The safety semantics behind them are explained in [Safety Model & Profiles](./safety.md).

**Personal agent on your own machine (fluent):**

```json
"env": {
  "MCP_SAFETY_MODE": "off",
  "MCP_COMMAND_CONFIRMATION": "risk-gated"
}
```

**Shared or CI environment (confirming):**

```json
"env": {
  "MCP_SAFETY_MODE": "normal",
  "MCP_COMMAND_CONFIRMATION": "all",
  "MCP_AUDIT_MODE": "all"
}
```

**Locked-down host (allowlist):**

```json
"env": {
  "MCP_SAFETY_MODE": "strict",
  "MCP_COMMAND_POLICY": "allow",
  "MCP_COMMAND_ALLOW": "git,node,npm,pnpm"
}
```

---

> This project makes no guarantees about update frequency, issue resolution timelines, or long-term support.
