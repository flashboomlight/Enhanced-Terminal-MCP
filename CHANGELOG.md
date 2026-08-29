# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Production conformance gate: `pnpm run gate` is now the canonical release gate and runs build, type-check, lint, full tests, main/tools coverage, latency, production dependency audit, package verification, an actual pack, and clean npm consumer startup. The same script accepts `--ci` so CI can keep the existing latency advisory policy without duplicating the gate command chain; CI invokes the same entry, pins third-party actions to full-length commit SHAs, and runs least-privilege (`contents: read`).
- Added real stdio MCP conformance checks, a bounded hostile-input corpus, and cross-platform smoke checks for Windows/Linux/macOS and Node 20/22/24. Gate reports are written under `.etmcp/gate-report.json` without retaining full command output.
- Partial-result contract for search/list tools (production audit SEARCH-01/SEARCH-02): `search_files`, `everything_search`, `grep_content`, and `list_directory` now return `complete` + `warnings` (search tools also `truncated`); traversal/read failures (native walk readdir, PowerShell `-ErrorVariable` aggregation, Unix grep partial output, unreadable recursive subdirectories) surface as structured warning codes (`WALK_READ_FAILED` / `PS_PARTIAL_WALK_ERRORS` / `GREP_PARTIAL_RESULTS` / `GREP_FILE_READ_FAILED` / `EVERYTHING_EXEC_FAILED`) with `complete=false` instead of being silently swallowed. Warning collection is bounded (50 entries, `WARNINGS_TRUNCATED` terminator; paths capped at 256 chars) and grep match lines are capped at 1000 chars with a truncation marker. Partial (`complete=false`) results are never written to the shared LRU cache.
- `everything_search` CLI error classification: timeouts map to `TIMEOUT`, output-buffer overflows to `RESOURCE_LIMIT`, and other non-zero exits to `EXECUTION_FAILED` with bounded detail (`{exitCode, signal}` only — no stdout/stderr full text); a zero-match exit stays a successful empty result (`complete=true`), and `search_files` still falls back to native search after an Everything CLI failure, now with an observable `EVERYTHING_EXEC_FAILED` warning.
- State-observability hardening (production audit OPS-01/OPS-02): a new `src/lock-lease.ts` gives the temp lock and the migration lock owner records, lease heartbeats (a live holder is never force-taken over, no matter how long it holds), and monotonic fencing tokens (takeovers preserve/increment the fence; destructive cleanup verifies the fence before deleting); a crashed migration-lock owner is recovered immediately while an unknown/corrupt migration lock stays fail-closed.
- Audit writer contract (`src/audit.ts`): writes are serialized through a single-flight chain; a failed append now retains the queued entries and retries with backoff instead of silently dropping them (`record()` returns `{accepted, queued, dropped}`, `flush(deadline)` returns a `FlushReport`); the queue has entry/byte caps (`MCP_AUDIT_QUEUE_MAX_ENTRIES`/`_BYTES`, overflow drops the oldest and counts it), oversized entries keep a `{truncated: true}` skeleton (`MCP_AUDIT_MAX_ENTRY_BYTES`), and the file rotates by size (`MCP_AUDIT_MAX_FILE_BYTES`, keeps `MCP_AUDIT_MAX_ROTATIONS` generations).
- Session revision writer: mutations during a session write are detected via a revision counter and re-saved immediately instead of being lost to the post-write dirty-flag reset; concurrent saves are serialized through a single-flight chain.
- Cross-process temp quota: outstanding reservations are mirrored into `<state-dir>/temp/.quota.json` under the temp lock; concurrent server processes now see each other's outstanding bytes, stale entries of dead processes are recycled, and coordination files no longer count toward the payload budget.
- LRU result-cache oversized-entry protection: a cache entry larger than half the memory budget is rejected (`oversizedRejected` stat) instead of evicting every hot entry and inserting anyway.
- Truthful `health://status`: `status` is now `healthy`/`degraded`/`failed` aggregated from four components (audit writer, temp capacity/lock, process termination failures, session persistence) under `components.*`, instead of an unconditional `ok`; `telemetry_report` reports the audit writer state.
- Tools-layer coverage gate `pnpm run test:coverage:tools` (`vitest.tools-coverage.config.ts`, floors: statements/lines 55, functions 60, branches 45) so the layer excluded from global coverage stays measured and regression-guarded; new unit suites for `files` / `manage` / `system` / `archive` tools (27 cases).
- `prepack` clean builds, self-contained source maps, an explicit MIT `LICENSE`, source/npm bootstrap separation, and the zero-dependency `scripts/verify-package.mjs` tarball verifier with SHA-256 evidence.
- An explicit `tsx` devDependency for the `dev` source entry; source bootstrap now validates Node 20+/pnpm 11.21.0 and supports `--non-interactive`.
- Documentation closeout (production-hardening #13): the 4.0.0 CHANGELOG section no longer carries contradictory pre-v4 headless entries (the breaking-changes narrative already covers that lifecycle); the `usage-guide` prompt highlights were refreshed to v4.0; stale `remaining-hardening` roadmap pointers were replaced with closed-roadmap status across README/AGENTS/ARCHITECTURE; a root `SECURITY.md` documents the threat model, the unclosable hardBlock floor, execution profiles, dependency policy, and vulnerability reporting; the `tests/e2e-latency.test.ts` header was updated to v4.0.0.

### Changed

- Adaptive command timeout now uses the real nearest-rank P95 of non-cache-hit latency samples (P95×3, capped at 4× the base timeout, falls back to the base timeout with fewer than 5 samples) instead of the previous average×3 heuristic (production audit PERF-01); docs and skewed-distribution tests match the implementation.
- Unix `process_list` no longer leaks the full unfiltered `ps aux --sort=-%mem` output when a filter is given: the command is rebuilt as filter-first (`grep -i` → `sort -k4,4 -rn` → `head`) and no longer relies on GNU `--sort` (production audit SYS-01); `top` (1–100) and `filter` (≤128 chars) are validated before any spawn.
- Input hardening: `search_files` / `everything_search` / `grep_content` / `list_directory` / `process_list` reject out-of-range parameters (`max_results`, `max_depth`, overlong `pattern`/`query`/`file_pattern`/`filter`, `top`) with `VALIDATION_ERROR` at both the schema layer and the handler layer (direct-invocation path cannot bypass), instead of silently accepting them.
- `postinstall` MCP SDK patch is now fail-closed and package-owned: a changed SDK version, layout, or patch pattern fails the install instead of silently skipping the `required: []` compatibility patch. Behavior is covered by `tests/unit/sdk-patch.test.ts`.
- `health://status` `status` field values changed from a fixed `"ok"` to `"healthy" | "degraded" | "failed"`; clients that string-match `"ok"` should match on the new value set (the MCP resource payload is not part of the tools' I/O contract).
- Tool surface contract: `wrapHandler` now converts unexpected handler throws into `INTERNAL_ERROR` tool results (messages pass the secret redactor; cancellation escapes map to `CANCELLED`) instead of rejecting the promise, and enforces a response byte budget via `MCP_RESPONSE_MAX_BYTES` (default 2 MiB; oversized responses become `RESOURCE_LIMIT` error envelopes). Tool count sources (startup banner, `health://status` `tools.enabled/disabled`, usage-guide prompt) now derive from the real enabled tool registry, matching `tools/list` (27/26).
- `session_state` (`set_cwd` requires `cwd`; `set_env` requires `key`+`value`), `environment_vars` (`get` requires `name`), and `network_info` (`ping`/`dns` require `target`) now reject missing action-dependent fields with `VALIDATION_ERROR` instead of silently no-op'ing; the implicit ping-to-127.0.0.1 / nslookup-to-localhost defaults (which bypassed host and egress validation) were removed.
- Capability matrix wired in: `process_list`, `get_system_info`, `network_info`, `download_file`, and `environment_vars` check the execution profile capability policy; `local-trusted-shell` is unchanged, an undeclared capability under `sandboxed-production` returns `CAPABILITY_DENIED`.
- Refreshed the SDK 1.29.0 dependency tree to patched transitive versions with a blocking `pnpm audit --prod --audit-level=high` release check; the SDK wire/API compatibility baseline remains unchanged.
- Hardened the source pwsh bootstrap with a 120-second download timeout, a 250 MB archive cap, and staged reparse-point rejection; SDK patch writes now use same-directory atomic replacement.
- `src/paging.ts` split into `src/paging/{codec,index-format,paths,errors}.ts` with the public API re-exported unchanged (1141-line file reduced to orchestration + facade).
- `src/temp-manager.ts` infrastructure (helpers, env readers, errors, interfaces, `AsyncMutex`, `ReservationImpl`) extracted to `src/temp-core.ts`; public API unchanged.
- `command.ts`: execute/watch shared preamble extracted (`resolveCommandLimits` / `prepareInvocation` / `finishCommandEnvelope`); no behavior change.
- `adaptive.ts` `DEFAULT_TIMEOUTS` now only registers `execute_command` (the single call site); other entries were unreachable config.
- Tests use project-internal `.etmcp/test-tmp` instead of the machine-specific `E:/Codex_Temp`; codestable roadmap directories normalized to `YYYY-MM-DD-<slug>` naming with all path references updated.

### Fixed

- `MCP_SHELL=cmd` flavor: commands containing quoted paths with spaces (e.g. `type "D:\my dir\file.txt"`) now execute correctly instead of failing with `文件名、目录名或卷标语法不正确`. The cmd invocation is built as verbatim `cmd /d /s /c "<command>"` (the npm/cross-spawn standard form), so embedded quotes reach cmd intact; `/d` also skips cmd AutoRun scripts. Plain commands are unaffected, and the pwsh/powershell/unix branches are unchanged.

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
- `ENHANCED_TERMINAL_DISABLE_FILE_INFO=1` switch to hide the `file_info` tool (27 tools by default, 26 when set).
- Unified state directory `<project-root>/.etmcp` (session, audit, temp) with transactional migration of legacy `session.json`/`logs/audit.jsonl`; `temp`/unknown files are never migrated.
- Command output A+ runtime: shared raw-byte capture, spill to page cache v2 (`stdout.bin`/`stderr.bin`/`stdout.idx`/`meta.json`), `cache_id` paged reads without re-run, `SECRET_DETECTED` error code, and the full `CommandOutputEnvelope` for `execute_command`/`batch_execute`/`watch_command`.
- Output governance env vars `MCP_COMMAND_MEMORY_OUTPUT_BYTES` / `MCP_COMMAND_MAX_STDERR_BYTES` / `MCP_TEMP_MAX_TOTAL_BYTES` with process-level validation (`VALIDATION_ERROR` on invalid values).
- Everything CLI local-optional resolution (`ENHANCED_TERMINAL_ES_PATH` → `<state-dir>/tools/es.exe` → unavailable) with fingerprint + locked SHA-256; `search_files` fallback, structured `everything_search` installation detail, zero-download runtime, and `es.exe` removal from the npm package.
- Build output cleanup before TypeScript compilation so removed source files do not remain in `build/` or npm packages.

### Changed

- Unit tests live under `tests/unit/`; `patch-package` is devDependency only.
- Package `files` ships `scripts/apply-mcp-sdk-patch.mjs` instead of relying on production `patch-package`.
- Session/audit/temp locations moved to `.etmcp` under the project root; `MCP_STATE_DIR` override disables automatic legacy migration.
- cmd/powershell inline non-ASCII mojibake fixed in the M2 output-decoding layer (`src/command-output.ts`); shell selection and invocation unchanged.

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
