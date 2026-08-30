# Troubleshooting

[中文版 (Chinese)](./troubleshooting.zh-CN.md)

Each entry: symptom → cause → fix. If none of these match, set `MCP_LOG_LEVEL=debug`, restart the server, and check the client's MCP logs plus the audit log (below) before filing an issue.

## Installed pwsh but the server still uses PowerShell 5.1

**Cause:** Windows shell resolution (`MCP_POWERSHELL_PATH` → bundled `tools/pwsh` → `PATH` → 5.1 fallback) is cached for the process lifetime.

**Fix:** restart the MCP server (restart the client or its MCP server entry) after installing pwsh or changing `MCP_SHELL` / `MCP_POWERSHELL_PATH`.

## `everything_search` says Everything is unavailable / `search_files` is slow on Windows

**Cause:** Everything is **not distributed** with this package — neither the app nor the `es.exe` CLI.

**Fix:** install Everything from voidtools, then point the server at `es.exe` via `ENHANCED_TERMINAL_ES_PATH` (absolute path) or place the file at `<state-dir>/tools/es.exe`. A failed resolution is **not** cached — installing later works without a restart. Without Everything, `search_files` automatically uses native search, and `everything_search` returns structured installation detail. See [Platform Notes](../README.md#platform-notes).

## `search_files` is slow on large trees (Linux/macOS)

**Cause:** the built-in native recursive search is the fallback when no `fd` binary is found.

**Fix:** install fd via your package manager (e.g. `apt-get install -y fd-find` — the binary may be named `fdfind`), or set `ENHANCED_TERMINAL_FD_PATH` to an explicit path. An invalid explicit path fails closed with `VALIDATION_ERROR` instead of silently falling back.

## The tool list shows 26 tools, not 27

**Cause:** `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` is set, which removes `file_info` from the surface.

**Fix:** unset the variable and restart the server if you want `file_info` back. `health://status` (`tools.enabled` / `tools.disabled`) reports the same count as `tools/list`.

## `compress_archive` / `extract_archive` fail on Linux

**Cause:** the archive tools shell out to the system `zip` / `unzip` binaries, which minimal images often lack.

**Fix:** install them via your package manager (e.g. `apt-get install -y zip unzip`).

## Where is the state directory? Can I move it?

**Cause:** sessions, audit logs, the page cache, and temp resources live under `<project-root>/.etmcp` by default. The directory (and its `temp/` child) is created lazily — only when the first real artifact is persisted — so it may legitimately not exist yet.

**Fix:** set `MCP_STATE_DIR` to override. Note: with the override set, legacy state under `.enhanced-terminal-mcp` is **not** migrated automatically (migration only happens for the default root; `temp/` and unknown files are never migrated).

## How do I see what the server is doing?

**Fix:** three observability surfaces —

1. `MCP_LOG_LEVEL=debug` for verbose stderr logs (the client surfaces these per its own UI).
2. `MCP_AUDIT_MODE=all` records every tool call to `<state-dir>/logs/audit.jsonl`; read recent entries via the `audit://log` resource.
3. `health://status` reports `healthy` / `degraded` / `failed` with per-component detail (audit writer, temp capacity, process supervisor, session persistence); `telemetry_report` shows per-tool latency/error/cache metrics.

## A command was blocked with `COMMAND_DANGEROUS` in `off` mode

**Cause:** the hardBlock floor (destructive-pattern block) is unclosable in every mode, including `off` — this is deliberate.

**Fix:** rephrase the command to avoid the destructive pattern. There is no configuration to disable the floor; see [Safety Model](./safety.md#the-hardblock-floor-always-on).
