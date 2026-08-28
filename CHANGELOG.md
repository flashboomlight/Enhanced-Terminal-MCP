# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI workflow (`.github/workflows/ci.yml`): lint + type-check on ubuntu, build/test/tools-coverage gate on a Windows runner (Node 22/24); the latency benchmark runs non-blocking (thresholds are calibrated on dev hardware).
- `pnpm run gate`: one-shot local gate (build + tsc + lint + test + latency + tools-coverage).
- Tools-layer coverage gate `pnpm run test:coverage:tools` (`vitest.tools-coverage.config.ts`, floors: statements/lines 55, functions 60, branches 45) so the layer excluded from global coverage stays measured and regression-guarded; new unit suites for `files` / `manage` / `system` / `archive` tools (27 cases).
- `postinstall` MCP SDK patch is now fail-closed and package-owned: a changed SDK version, layout, or patch pattern fails the install instead of silently skipping the `required: []` compatibility patch. Behavior is covered by `tests/unit/sdk-patch.test.ts`.

### Changed

- Refreshed the SDK 1.29.0 dependency tree to patched transitive versions with a blocking `pnpm audit --prod --audit-level=high` release check; the SDK wire/API compatibility baseline remains unchanged.
- Added `prepack` clean builds, self-contained source maps, an explicit MIT `LICENSE`, source/npm bootstrap separation, and the zero-dependency `scripts/verify-package.mjs` tarball verifier with SHA-256 evidence.
- Added an explicit `tsx` devDependency for the `dev` source entry; source bootstrap now validates Node 20+/pnpm 11.21.0 and supports `--non-interactive`.
- Hardened the source pwsh bootstrap with a 120-second download timeout, a 250 MB archive cap, and staged reparse-point rejection; SDK patch writes now use same-directory atomic replacement.
- `src/paging.ts` split into `src/paging/{codec,index-format,paths,errors}.ts` with the public API re-exported unchanged (1141-line file reduced to orchestration + facade).
- `src/temp-manager.ts` infrastructure (helpers, env readers, errors, interfaces, `AsyncMutex`, `ReservationImpl`) extracted to `src/temp-core.ts`; public API unchanged.
- `command.ts`: execute/watch shared preamble extracted (`resolveCommandLimits` / `prepareInvocation` / `finishCommandEnvelope`); no behavior change.
- `adaptive.ts` `DEFAULT_TIMEOUTS` now only registers `execute_command` (the single call site); other entries were unreachable config.
- Tests use project-internal `.etmcp/test-tmp` instead of the machine-specific `E:/Codex_Temp`; codestable roadmap directories normalized to `YYYY-MM-DD-<slug>` naming with all path references updated.

## [4.0.0] — 2026-08-28

### Breaking Changes

- **Removed the headless workspace-delete surface** (supersedes the 2026-08-23 headless feature; DEC-002 — aligned with the official MCP philosophy: Roots deprecated by SEP-2577, filesystem boundaries belong to the host sandbox, risky operations go through per-action Elicitation):
  - `delete_preview` tool removed — the tool surface is now **27 tools** (26 when `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`).
  - `MCP_CONFIRMATION_MODE` and `MCP_ALLOWED_ROOTS` environment variables removed; stale values in existing configs are inert (no longer parsed, no warnings, no blocking).
  - `delete_path` no longer accepts `preview_id`; it is protected by Elicitation confirmation (normal mode) and the unchanged hard security floor.
  - `health://status` no longer reports `confirmation_mode`, `allowed_roots`, or `headless_surface`.
- **Added `MCP_COMMAND_CONFIRMATION=all|risk-gated`** (default `all` = previous behavior): in `risk-gated`, ordinary commands execute without confirmation while heavy commands (batch >5, destructive residue, performance words, `watch_command` duration >60s) require one Elicitation confirmation carrying the risk reason. With `MCP_SAFETY_MODE=off`, only ordinary is exempted — heavy commands still confirm. Recommended personal-agent profile: `MCP_SAFETY_MODE=off` + `MCP_COMMAND_CONFIRMATION=risk-gated`.
- Safety decision order is now strict → (risk-gated grading) → off → normal; heavy decisions are audited as `safety.decision` with `risk_level`/`risk_category` (no command originals). The heavy rule table is corpus-governed (`tests/fixtures/command-risk-corpus.json`).

### Added

- Command policy: `MCP_COMMAND_POLICY=allow` with `MCP_COMMAND_ALLOW`, shell metacharacter rejection, hardBlock first.
- Security regression corpus: `tests/fixtures/security-corpus.json` + `tests/unit/security-corpus.test.ts`.
- Policy audit fields: `detail.category` + `detail.policyMode` on `safety.block`.
- Secrets scan tiers: `MCP_SECRETS_SCAN=off|write|cache|strict` (default `cache`; `strict` blocks secret reads).
- Batch rate mode: `MCP_BATCH_RATE_MODE=batch|per_command` (default `batch`).
- `pool_stats` structured field `active: false` (pool remains inactive).
- es.exe SHA-256 gate (`src/es-integrity.ts`); zero-dep MCP SDK postinstall patch script.
- CodeStable roadmap `remaining-hardening` + boundary decisions (shell ≠ sandbox, allow optional, zod v3).
- Default Windows shell switched to PowerShell 7 (`MCP_SHELL=pwsh`) with `MCP_POWERSHELL_PATH` explicit fail-closed override, bundled portable pwsh bootstrap via `setup.bat`, and `powershell`/`cmd` compatibility modes.
- `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` switch to hide the `file_info` tool (27 tools when set after the workspace-delete tool was added).
- Unified state directory `<project-root>/.etmcp` (session, audit, temp) with transactional migration of legacy `session.json`/`logs/audit.jsonl`; `temp`/unknown files are never migrated.
- Command output A+ runtime: shared raw-byte capture, spill to page cache v2 (`stdout.bin`/`stderr.bin`/`stdout.idx`/`meta.json`), `cache_id` paged reads without re-run, `SECRET_DETECTED` error code, and the full `CommandOutputEnvelope` for `execute_command`/`batch_execute`/`watch_command`.
- Output governance env vars `MCP_COMMAND_MEMORY_OUTPUT_BYTES` / `MCP_COMMAND_MAX_STDERR_BYTES` / `MCP_TEMP_MAX_TOTAL_BYTES` with process-level validation (`VALIDATION_ERROR` on invalid values).
- Everything CLI local-optional resolution (`ENHANCED_TERMINAL_ES_PATH` → `<state-dir>/tools/es.exe` → unavailable) with fingerprint + locked SHA-256; `search_files` fallback, structured `everything_search` installation detail, zero-download runtime, and `es.exe` removal from the npm package.
- Build output cleanup before TypeScript compilation so removed source files do not remain in `build/` or npm packages.
- Workspace-delete headless surface: `delete_preview` plus preview-bound `delete_path`, trusted `MCP_ALLOWED_ROOTS`, reparse-safe snapshots, and structured Elicitation errors.

### Changed

- Unit tests live under `tests/unit/`; `patch-package` is devDependency only.
- Package `files` ships `scripts/apply-mcp-sdk-patch.mjs` instead of relying on production `patch-package`.
- Session/audit/temp locations moved to `.etmcp` under the project root; `MCP_STATE_DIR` override disables automatic legacy migration.
- cmd/powershell inline non-ASCII mojibake fixed in the M2 output-decoding layer (`src/command-output.ts`); shell selection and invocation unchanged.
- Tool surface is now 28 tools by default (27 when `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1`); default normal Elicitation behavior remains compatible and headless is limited to workspace deletion.

### Fixed

- Headless workspace-delete surface is now enforced regardless of `MCP_SAFETY_MODE`: `MCP_SAFETY_MODE=off` no longer re-enables command/write/archive/download/process tools in headless mode (a startup warning is logged; `strict` still blocks `delete_path` itself).
- `make_directory` is rejected in headless mode; it previously escaped the workspace-delete surface.
- Safety refusals (`ELICITATION_REQUIRED`, `ELICITATION_CANCELLED`, headless `SAFETY_BLOCKED`) are now recorded in the audit log as `safety.decision` entries without secrets.
- Expired `delete_preview` tokens are swept whenever a new preview is created.

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
