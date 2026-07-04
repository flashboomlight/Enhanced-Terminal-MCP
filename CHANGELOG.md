# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.1.0] - 2026-07-05

### Added

- Session persistence: cwd, env vars, and command history are auto-saved to `.enhanced-terminal-mcp/session.json` and restored on restart.
- Structured JSON Lines audit log at `.enhanced-terminal-mcp/logs/audit.jsonl` with modes `off` / `errors` / `all`.
- Temp Resource Manager with TTL + LRU eviction under `.enhanced-terminal-mcp/temp/`.
- Command output paging for `execute_command` via `page` / `pageSize`.
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

## [3.0.0] - Earlier

- Initial public release with command execution, file I/O, system management, search, archives, and safeguard features.
