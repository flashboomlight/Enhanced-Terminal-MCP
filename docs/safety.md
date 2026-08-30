# Safety Model & Profiles

[中文版 (Chinese)](./safety.zh-CN.md)

This server executes **full shell strings on the host**. Its safety layers are **defense in depth, not a sandbox** — do not expose it to untrusted clients or networks; by design one server process binds a single stdio client. Filesystem-boundary enforcement belongs to the host sandbox per the MCP specification. The threat model and reporting process live in [SECURITY.md](../SECURITY.md); this page is the practical guide to the knobs.

## The three safety modes

Set with `MCP_SAFETY_MODE`:

| Mode | Behavior |
|------|----------|
| `strict` | All guarded tools are blocked outright: `execute_command`, `batch_execute`, `watch_command`, `write_file`, `copy_move`, `delete_path`, `compress_archive`, `extract_archive`, `download_file`, `kill_process`. Read-only tools still work. |
| `normal` (default) | Guarded tools require a per-action confirmation via MCP Elicitation. Clients without form Elicitation support receive an `ELICITATION_REQUIRED` error instead. |
| `off` | No confirmation prompts. The hardBlock floor still applies (see below). |

## The hardBlock floor (always on)

A fixed set of destructive command patterns (e.g. disk wiping, fork bombs, `iex`-style remote script execution) is blocked in **every** mode, including `MCP_SAFETY_MODE=off`. There is no switch to disable it; this is a recorded, deliberate baseline.

## Command policy: blocklist or allowlist

`MCP_COMMAND_POLICY` selects how commands are screened before execution:

- `blocklist` (default) — dangerous-pattern matching plus the hardBlock floor.
- `allow` — only executables named in `MCP_COMMAND_ALLOW` (comma-separated, e.g. `git,node,pnpm`) may run; shell chaining/metacharacters are rejected. hardBlock still applies on top.

## Command confirmation: all vs risk-gated

`MCP_COMMAND_CONFIRMATION` tunes how the three command tools (`execute_command`, `batch_execute`, `watch_command`) interact with the safety mode:

- `all` (default) — in `normal` mode every command tool call asks for confirmation. Unchanged long-time behavior.
- `risk-gated` — ordinary commands run without prompting; only **heavy** commands confirm once, with the reason attached: batches of more than 5 commands, commands with destructive residue, performance-sensitive wording, or `watch_command` durations over 60s. In `off` mode this is the recommended companion: ordinary commands flow, heavy ones still stop once.

Invalid values fall back to `all` with a startup warning. `strict` blocks command tools regardless of this setting.

## Defense layers at a glance

1. **hardBlock floor** — unclosable destructive-pattern block (all modes).
2. **Safety mode** — strict/normal/off gating of the ten guarded tools.
3. **Command policy** — blocklist or executable allowlist.
4. **Path & content checks** — traversal detection, forbidden paths, sensitive-file patterns, and secret scanning (`MCP_SECRETS_SCAN`) on writes and cached reads.
5. **Network & archive budgets** — SSRF policy on `download_file`, zip-bomb guards on extraction; see [Configuration](./configuration.md#download--archive).
6. **Rate limiting** — token bucket (10 req/s) on the command tools.

## Recommended profiles

**Personal agent on your own machine** — fluent but not reckless:

```json
"env": { "MCP_SAFETY_MODE": "off", "MCP_COMMAND_CONFIRMATION": "risk-gated" }
```

Ordinary commands execute immediately; heavy commands stop once with the risk reason; hardBlock stays on.

**Shared or CI environment** — every destructive action is confirmed and logged:

```json
"env": { "MCP_SAFETY_MODE": "normal", "MCP_COMMAND_CONFIRMATION": "all", "MCP_AUDIT_MODE": "all" }
```

**Locked-down host** — only known executables, no shell metacharacters:

```json
"env": { "MCP_SAFETY_MODE": "strict", "MCP_COMMAND_POLICY": "allow", "MCP_COMMAND_ALLOW": "git,node,npm,pnpm" }
```

Note `strict` also blocks the command tools entirely; combine profiles thoughtfully (e.g. `normal` + allow policy when you still need confirmed command execution).

## What this server does not promise

- No sandboxing of executed commands — a confirmed command runs with your user privileges.
- No filesystem-root allowlist (the former mechanism was removed in v4.0.0); per-action Elicitation is the boundary, plus whatever sandbox your host provides.
- No protection against a hostile client driving the tools — the trust boundary is the client connection itself.
