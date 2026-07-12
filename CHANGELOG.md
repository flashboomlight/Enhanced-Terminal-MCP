# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Command policy: `MCP_COMMAND_POLICY=allow` with `MCP_COMMAND_ALLOW`, shell metacharacter rejection, hardBlock first.
- Security regression corpus: `tests/fixtures/security-corpus.json` + `tests/unit/security-corpus.test.ts`.
- Policy audit fields: `detail.category` + `detail.policyMode` on `safety.block`.
- Secrets scan tiers: `MCP_SECRETS_SCAN=off|write|cache|strict` (default `cache`; `strict` blocks secret reads).
- Batch rate mode: `MCP_BATCH_RATE_MODE=batch|per_command` (default `batch`).
- `pool_stats` structured field `active: false` (pool remains inactive).
- es.exe SHA-256 gate (`src/es-integrity.ts`); zero-dep MCP SDK postinstall patch script.
- CodeStable roadmap `remaining-hardening` + boundary decisions (shell ≠ sandbox, allow optional, zod v3).

### Changed

- Unit tests live under `tests/unit/`; `patch-package` is devDependency only.
- Package `files` ships `scripts/apply-mcp-sdk-patch.mjs` instead of relying on production `patch-package`.

## [3.1.0] - 2026-07-05

### Added

- Session persistence: cwd, env vars, and command history are auto-saved to `.enhanced-terminal-mcp/session.json` and restored on restart.
- Structured JSON Lines audit log at `.enhanced-terminal-mcp/logs/audit.jsonl` with modes `off` / `errors` / `all`.
- Temp Resource Manager with TTL + LRU eviction under `.enhanced-terminal-mcp/temp/`.
- Command output paging for `execute_command` via `cache_id` / `page` / `pageSize`.
- Utility tools: `telemetry_report`, `cache_stats`, `cache_invalidate`, `session_state`, `pool_stats`, `temp_stats`.
- `TempManager` supports background auto-cleanup and on-demand `cleanup()` / `stats()`.
- Added unit tests for `search.ts` (`globToRegex`), `utility.ts` pure helpers, `stream.ts`, and Unix branches of `platform.ts`.

### Changed

- Upgraded `@modelcontextprotocol/sdk` from `^1.26.0` to `^1.29.0` and refreshed the patch.
- Excluded test files from `build/` output via `tsconfig.json`.
- Refactored `utility.ts` to extract pure formatting/validation helpers and improve testability.
- Unified PowerShell invocation in `grep_content` to use a script block (`& { ... }`), fixing `param()` parsing when invoked via `execFile`.
- Improved test coverage to 95.52% lines, 94.43% statements, 87.94% branches, 94.27% functions.

### Fixed

- `grep_content` no longer silently returns success when PowerShell fails; it returns an explicit `EXECUTION_FAILED` error with retryable details.
- `TempManager.init()` now correctly re-initializes when `MCP_STATE_DIR` changes between instances.
- `SessionStore` exported as instantiable class for test isolation.
- Normal safety mode now requires confirmation for all destructive tools, including command execution tools.
- `execute_command` paged output now returns `cache_id`, and later pages can be read without re-running the command.
- Audit logs are compacted to `MCP_AUDIT_MAX_ENTRIES` instead of growing without bound.
- The npm package now uses a `files` whitelist, includes the Unix shebang for the bin entry, and keeps `patch-package` available for postinstall.
- Cleared current npm audit findings by refreshing vulnerable transitive dependency versions.
- `safeExec` / `safeExecFile` now reject non-zero exits even when stderr/stdout is present, preventing failed system/archive/download commands from being reported as successful.
- Safety confirmation now covers `copy_move`, `compress_archive`, `extract_archive`, and `download_file`; `watch_command` is no longer annotated as read-only.
- `execute_command` now applies `session_state set_env` values to spawned commands and returns an explicit error when stdout exceeds `MCP_COMMAND_MAX_OUTPUT_BYTES`.
- `watch_command` now returns an error for non-zero command exits instead of reporting them as successful captures.
- Paged output `cache_id` values are validated before disk lookup to prevent path traversal outside the temp cache root.
- `grep_content` now applies `max_results` globally and can return multiple matches from the same file.
- Dangerous PowerShell `Remove-Item` root-drive patterns now cover both `C:\` and `C:/` forms.
- Package engines now declare the project requirement of Node.js 20+.

## [3.0.0] - Earlier

- Initial public release with command execution, file I/O, system management, search, archives, and safeguard features.
