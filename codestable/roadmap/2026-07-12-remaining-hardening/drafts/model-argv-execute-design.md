---
doc_type: spike
slug: model-argv-execute-design
roadmap: remaining-hardening
roadmap_item: model-argv-execute-design
status: draft
created: 2026-07-12
---

# Design spike: argv / non-shell command execution

> **Not implemented.** This document is the B-track design seed from `remaining-hardening`.
> Do **not** change default `execute_command` behavior until this design is approved and a feature is scheduled.

## Problem

`execute_command` always builds a shell string (`cmd.exe /c` / `sh -c`). Application-layer hardBlock + allow policy reduce risk but **cannot** prove safety for arbitrary shell languages (see `decision-command-execution-not-sandbox`).

## Goals

1. Offer a path where the server never invokes a shell interpreter.
2. Keep current shell tool for power users / default AI coding workflows.
3. Reuse session cwd/env sanitization and hardBlock baseline where applicable.

## Non-goals

- Full OS sandbox (Job Object / seccomp) — separate spike `model-os-sandbox-spike`.
- Making allow policy the default.
- Parsing shell scripts client-side.

## Proposed API (options)

### Option A — New tool `execute_command_argv` (preferred)

```ts
// input
{
  file: string,              // executable name or absolute path
  args?: string[],           // argv only, no shell expansion
  cwd?: string,
  timeout?: number,
  env?: Record<string, string>  // optional overlay; still filtered by session rules
}
// output: same shape as execute_command success/failure without shell wrapping
```

**Security:**

- `spawn(file, args, { shell: false, env: merged })`
- Allow mode: match `basename(file)` against allowlist
- hardBlock: scan `file + " " + args.join(" ")` as best-effort **or** only basename + known-dangerous arg patterns
- Reject `file` containing path traversal / null bytes

### Option B — Flag on existing tool

```ts
execute_command({ command?: string, argv?: { file, args }, shell?: boolean })
```

**Risk:** schema union complexity; LLMs mix fields; harder to document.

**Recommendation:** Option A for clarity.

## Migration

| Audience | Path |
|----------|------|
| Default AI coding | Keep shell `execute_command` |
| Hardened deploy | Prefer argv tool + `MCP_COMMAND_POLICY=allow` for remaining shell tools or disable shell tools via future flag |
| Docs | README table “when to use which” |

## Open questions (need product input)

1. Should shell tools be disableable via env (`MCP_SHELL_COMMANDS=off`)?
2. Does argv tool need paging / max output same as shell?
3. Windows: resolve `file` via `PATHEXT` or require absolute path?

## Exit criteria for “design approved”

- [ ] Option A/B chosen
- [ ] Security checklist written as testable corpus entries
- [ ] Compatibility statement for existing clients
- [ ] Explicit user authorization if any existing tool schema changes

## Next

After approval → `cs-feat-design` feature directory, not drive-by implementation.
