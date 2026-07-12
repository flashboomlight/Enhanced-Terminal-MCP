---
doc_type: spike
slug: model-os-sandbox-spike
roadmap: remaining-hardening
roadmap_item: model-os-sandbox-spike
status: draft
created: 2026-07-12
---

# Spike: OS-level sandbox for command execution

> Research only. **No production dependency** introduced by this note.

## Depends on

`model-argv-execute-design` — sandboxing a free-form shell is harder and less valuable than sandboxing argv spawn.

## Options matrix

| Approach | Platform | Pros | Cons |
|----------|----------|------|------|
| Windows Job Object + restricted token | win32 | Native, no Docker | Complex ACLs; still shares machine |
| Linux seccomp-bpf + namespaces | linux | Strong syscall filter | Needs native addon or bubblewrap; macOS gap |
| bubblewrap / firejail | linux | Userland | Extra binary; not on Windows |
| Docker/Podman per command | all (if daemon) | Strong isolation | Latency, daemon, volume mounts, not always available |
| Wasm / WASI runner | all | Portable | Cannot run real `npm`/`git` native tools |

## Feasibility (preliminary)

1. **Best fit for this product:** optional “sandbox profile” only when `execute_command_argv` exists; not for default shell.
2. **Do not** require Docker for default install — breaks “npm install && run MCP” UX.
3. **macOS:** no seccomp; sandbox-exec is deprecated/awkward; treat as best-effort or unsupported.

## Recommended decision path

1. Ship argv tool first without OS sandbox.
2. If enterprise demand: Windows Job Object PoC **or** document “run the MCP server inside your container” as supported deployment pattern (zero code).
3. Revisit native sandbox only with dedicated maintainer bandwidth.

## Explicit non-recommendation

Building a custom multi-OS sandbox runtime inside this repo is **out of scope** for remaining-hardening A-track.

## Exit criteria

- [ ] Written recommendation: “deployment isolation” vs “in-process sandbox”
- [ ] Cost estimate if any native dependency is proposed
- [ ] Go/no-go recorded in a decision doc if code is planned
