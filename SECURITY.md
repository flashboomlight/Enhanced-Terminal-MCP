# Security Policy

## Threat model and boundaries

- This server executes **full shell strings on the host**. Its security layers are **defense in depth, not a sandbox** — see the boundary decision in `codestable/compound/2026-07-12-decision-command-execution-not-sandbox.md`. Do not expose the server to untrusted clients or networks; by design one server process binds a single stdio client.
- `hardBlock` (the destructive-pattern floor) is **unclosable in every safety mode**, including `MCP_SAFETY_MODE=off` — see `codestable/compound/2026-07-11-decision-hardblock-uncloseable-baseline.md`.
- Filesystem-boundary enforcement belongs to the host sandbox per the MCP specification. The former `MCP_ALLOWED_ROOTS` / headless mechanism was removed in v4.0.0 (DEC-002, `codestable/compound/2026-08-28-decision-confirmation-model.md`); risky operations go through per-action Elicitation confirmation instead.
- Execution profiles: `local-trusted-shell` (default — trusts the local user) and `sandboxed-production` (expects the host to provide isolated workers, identity scoping, and egress control; undeclared capabilities fail closed with `CAPABILITY_DENIED`). This repository does **not** ship a sandbox backend or remote transport.

## Dependency maintenance

- `@modelcontextprotocol/sdk` is pinned exactly to `1.29.0` (wire/API compatibility baseline); the package-owned `postinstall` patch fails closed on version, layout, or pattern drift.
- The release gate blocks on `pnpm audit --prod --audit-level=high`; patched transitive versions are frozen in `pnpm-lock.yaml`.
- Zod stays on **v3** (see `codestable/compound/2026-07-12-decision-zod-v3-remain.md`).

## Reporting a vulnerability

Use GitHub **private security advisories** (preferred) for anything exploitable; otherwise open a GitHub Issue. Please include reproduction steps, the affected version, and the safety profile in effect (`MCP_SAFETY_MODE`, `MCP_COMMAND_CONFIRMATION`).

## Supported versions

| Version | Security fixes |
| --- | --- |
| 4.0.x | Yes |
| < 4.0.0 | No |
