# Tool Reference

27 tools (26 when `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`), verified against the server's live `tools/list` output. Your client's `tools/list` is always the final authority; this page adds the contracts and notes that the schemas don't show.

Categories: [Command](#command-tools) · [Files](#file-tools) · [File management](#file-management) · [Search](#search-tools) · [System](#system-tools) · [Archive & download](#archive--download-tools) · [Utility](#utility-tools) · [Resources](#resources) · [Prompts](#prompts)

## Cross-cutting contracts

### Command output envelope and paging

`execute_command`, `batch_execute`, and `watch_command` return a machine-readable envelope with `ok`, `stdout`, `stderr`, `exit_code`, `timed_out`, `cancelled`, `truncated`, byte counters (`total/retained` for stdout/stderr), and `paged`.

- Output up to `MCP_COMMAND_MEMORY_OUTPUT_BYTES` (default 1 MiB) stays in memory.
- Beyond that, output spills to a byte-indexed page cache under `<state-dir>/temp`, the envelope reports `paged: true`, and the structured content carries a `cache_id` plus page metadata.
- Read further pages **without re-executing** by calling `execute_command` with `cache_id` (plus `page` / `pageSize`). Cache mode rejects `command`, `cwd`, and `timeout`; command mode rejects `page`. Exactly one of `command` / `cache_id` must be provided.
- Absolute capture ceiling: `MCP_COMMAND_MAX_OUTPUT_BYTES` (default 50 MiB), after which the result is flagged `truncated`.

### Partial-result contract (search & listing)

`search_files`, `everything_search`, `grep_content`, and `list_directory` report:

- `complete` — `false` when traversal/read errors were skipped,
- `warnings` — bounded structured warning codes,
- `truncated` — a budget (`max_results` / depth) was reached.

Partial results (`complete: false`) are never cached.

### Error envelope

Failures return a structured error with one of 31 error codes (`PATH_TRAVERSAL`, `COMMAND_DANGEROUS`, `SAFETY_BLOCKED`, `ELICITATION_REQUIRED`, `SSRF_BLOCKED`, `ARCHIVE_LIMIT`, `RESOURCE_LIMIT`, `CANCELLED`, …) plus `retryable`, `suggestion`, and `param` hints so the model can self-correct. The full enum lives in `src/result.ts` and is the authority.

### Result caching

Read-only results are cached in a process-local LRU (128 entries, sliding TTL, ~32 MB cap): `read_file` 30s · `list_directory` 5s · `file_info` 30s · `search_files` 30s · `grep_content` 30s · `get_system_info` 60s. Use `cache_stats` / `cache_invalidate` to inspect or flush. Results containing detected secrets, and partial results, are never cached.

### Search platform behavior

| Platform | `search_files` engine | Resolution |
|----------|----------------------|------------|
| Windows | Everything (`es.exe`, you install it) → native fallback | `ENHANCED_TERMINAL_ES_PATH` → `<state-dir>/tools/es.exe` → unavailable |
| Linux / macOS | `fd` when available → native fallback | `ENHANCED_TERMINAL_FD_PATH` (fail-closed) → `fd`/`fdfind` on `PATH` → unavailable |

Nothing is downloaded at runtime. Details: [Platform Notes](../README.md#platform-notes).

## Command tools

Guarded by the safety layer (`strict` blocks; `normal` confirms; see [Safety Model](./safety.md)). Rate-limited by a token bucket (10 req/s; `MCP_BATCH_RATE_MODE` controls whether a batch costs one token or one per command).

### `execute_command`

Execute a single shell/terminal command. Returns structured result with exit code and stderr.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | no | The command to execute. Required unless cache_id is provided. |
| `cache_id` | string | no | Read a page from a previous paged command output without re-executing. |
| `cwd` | string | no | Working directory (optional) |
| `timeout` | integer | no | Timeout in ms, default 30000 (min 1, max 3600000) |
| `page` | integer | no | Page number to read from paged output, default 1 (min 1) |
| `pageSize` | integer | no | Characters per page, default 2000, max 10000 (min 1, max 10000) |

### `batch_execute`

Execute multiple commands sequentially. Stops on first error if stop_on_error is true (default).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `commands` | array | **yes** | Array of commands to execute |
| `cwd` | string | no | Working directory |
| `stop_on_error` | boolean | no | Stop if a command fails, default true |
| `parallel` | boolean | no | Execute commands in parallel (no dependencies), default false — parallel runs with concurrency 4 |

### `watch_command`

Execute a command and capture output for a limited duration. Useful for real-time monitoring; fails on non-zero exit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `command` | string | **yes** | The command to run |
| `duration` | integer | no | Max duration in ms, default 5000 (min 1, max 600000) |
| `cwd` | string | no | Working directory |

## File tools

### `read_file`

Read the contents of a file. Supports paging via offset/lines. Cached 30s.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | **yes** | Absolute path to the file |
| `encoding` | string | no | Encoding, default utf-8 (auto-detection applied) |
| `offset` | number | no | Start line number (1-indexed), default 1 |
| `lines` | number | no | Max lines to read, 0 = all |

### `write_file`

Write content to a file (creates parent dirs if needed). Guarded by the safety layer; secret scanning blocks credential writes.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | **yes** | Absolute path to the file |
| `content` | string | **yes** | Content to write |
| `append` | boolean | no | Append instead of overwrite, default false |

### `list_directory`

List files and directories in a path with details. Symlink cycle protection; partial-result contract applies. Cached 5s.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dir_path` | string | **yes** | Absolute path to directory |
| `recursive` | boolean | no | List recursively, default false |
| `max_depth` | integer | no | Max depth for recursive, default 3 (min 1, max 32) |

### `file_info`

Get detailed information about a file or directory (size, type, timestamps). Cached 30s. Can be removed from the surface with `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_path` | string | **yes** | Absolute path to file or directory |

### `make_directory`

Create a directory (including parent directories).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dir_path` | string | **yes** | Absolute path of directory to create |

## File management

Both tools are guarded by the safety layer.

### `copy_move`

Copy or move a file/directory to a new location.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | string | **yes** | Source path |
| `destination` | string | **yes** | Destination path |
| `operation` | enum(`copy` \| `move`) | **yes** | Operation: copy or move |

### `delete_path`

Delete a file or directory (use with caution!). Non-empty directories require `recursive: true`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target_path` | string | **yes** | Path to delete |
| `recursive` | boolean | no | Delete directory recursively, default false |

## Search tools

Platform behavior matrix: [above](#search-platform-behavior). Partial-result contract applies to all three.

### `search_files`

Search for files by name pattern. Uses the Everything engine for instant results on Windows (you provide es.exe), fd when available on Linux/macOS, falls back to native search. Cached 30s.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dir_path` | string | **yes** | Directory to search in |
| `pattern` | string | **yes** | Filename pattern, e.g. *.ts, *.log, test* |
| `max_depth` | integer | no | Max search depth for native fallback, default 5; engine paths (Everything/fd) search the full tree unless explicitly set (min 1, max 32) |
| `max_results` | integer | no | Max results, default 50 (min 1, max 500) |

### `everything_search`

Ultra-fast full-disk file search powered by Everything engine (Windows only). When Everything is unavailable, returns structured installation detail instead of an empty result.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | **yes** | Everything search query. Supports: wildcards(*.txt), regex, path:, size:, date: filters |
| `dir_filter` | string | no | Optional: limit search to this directory path |
| `max_results` | integer | no | Max results, default 100 (min 1, max 1000) |

### `grep_content`

Search file contents using regex pattern. Uses PowerShell Select-String on Windows, grep on Unix. Cached 30s.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dir_path` | string | **yes** | Directory to search in |
| `pattern` | string | **yes** | Regex pattern to search for in file contents |
| `file_pattern` | string | no | File name filter, e.g. *.ts, default * |
| `max_results` | integer | no | Max matching lines, default 50 (min 1, max 500) |

## System tools

### `get_system_info`

Get detailed system information (OS, CPU, memory, disk, GPU, etc.). Cached 60s. No parameters.

### `process_list`

List running processes, optionally filter by name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filter` | string | no | Filter processes by name |
| `top` | integer | no | Show top N processes by memory, default 20 (min 1, max 100) |

### `kill_process`

Kill a process by PID or name (`pid` or `name`, exactly one target). Refuses to kill critical system processes. Guarded by the safety layer.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pid` | integer | no | Process ID to kill (min 1, max 2147483647) |
| `name` | string | no | Exact process basename to kill |
| `force` | boolean | no | Force kill, default false |

### `network_info`

Get network configuration and connectivity info.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum(`config` \| `connections` \| `ping` \| `dns`) | no | Action: config, connections, ping, dns. Default: config |
| `target` | string | no | Target host (required for ping/dns) |

### `environment_vars`

Get or list environment variables (sensitive keys hidden; value display governed by `MCP_ENV_VALUE_MODE`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum(`get` \| `list`) | **yes** | get = get one var, list = list all |
| `name` | string | no | Variable name (required for get) |

## Archive & download tools

All three are guarded by the safety layer. Budgets (member count, expanded bytes, ratio, download size/deadline/redirects) are configured in [Configuration](./configuration.md#download--archive).

### `compress_archive`

Compress files/directories into a zip archive. On Linux/macOS shells out to the system `zip` binary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_path` | string | **yes** | Path to file or directory to compress |
| `output_path` | string | **yes** | Output zip file path |

### `extract_archive`

Extract a zip archive to a directory (validated members, size budgets, staging extraction). On Linux/macOS shells out to `unzip`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `archive_path` | string | **yes** | Path to the zip file |
| `output_dir` | string | **yes** | Directory to extract to |

### `download_file`

Download a file from an HTTP/HTTPS URL to a local path. Private/loopback/metadata targets are blocked by SSRF policy (MCP_SSRF_MODE=allow-private to allow), redirects are re-validated per hop, and size/deadline budgets apply.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | **yes** | URL to download from (http/https, no credentials) |
| `save_path` | string | **yes** | Local path to save the file |

## Utility tools

### `telemetry_report`

Get tool call metrics: latency, error rates, cache hit rates per tool. Use to debug performance.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `recent` | number | no | Show recent N calls, default 20 |

### `cache_stats`

Get LRU cache statistics: size, hit rate, capacity. Use to understand cache effectiveness. No parameters.

### `cache_invalidate`

Clear all or specific tool caches. Use when results become stale.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `tool` | string | no | Clear cache for specific tool only, or all if omitted |

### `session_state`

View or modify session state: working directory, environment variables. Session env applies to the command tools; persistence is governed by `MCP_SESSION_PERSIST_ENV_VALUES`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | enum(`get` \| `set_cwd` \| `set_env` \| `reset`) | **yes** | get=view state, set_cwd=change working dir, set_env=set env var, reset=clear session |
| `cwd` | string | no | New working directory (required for set_cwd) |
| `key` | string | no | Env var name (required for set_env) |
| `value` | string | no | Env var value (required for set_env; may be empty string) |

### `pool_stats`

Shell process pool stats. Currently inactive (execution uses on-demand spawnStream); size/idle/busy are always 0, max is capacity reserved for a future pool. No parameters.

### `temp_stats`

Get temporary resource statistics: total directories, size, oldest/newest age, removed count. No parameters.

## Resources

- `health://status` — JSON health check with version, metrics, cache, session, temp, and audit info. `status` is `healthy` / `degraded` / `failed`, aggregated from four components (audit writer, temp capacity, process supervisor, session persistence). Registered as a direct-read template: it does **not** appear in `resources/list`, but reading the URI works.
- `audit://log` — recent structured audit entries (default limit: 50). `audit://log?limit=N` requests a specific limit (clamped to 1–1000).

## Prompts

- `usage-guide` — tool overview with live session context injected.
- `safety-info` — current safety configuration (mode, elicitation support, tool count, cache stats).

---

> This project makes no guarantees about update frequency, issue resolution timelines, or long-term support.
