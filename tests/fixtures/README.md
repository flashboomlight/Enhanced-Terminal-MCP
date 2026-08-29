# Test fixtures

## security-corpus.json

Regression samples for `checkCommandPolicy` / hardBlock.

| Bucket | Meaning |
|--------|---------|
| `must_block` | Must be rejected under default `blocklist` (and usually all modes via hardBlock) |
| `must_allow_blocklist` | Must pass under default `blocklist` |
| `must_allow_allowmode` | Must pass under `MCP_COMMAND_POLICY=allow` with default allow prefixes |
| `allow_mode_block` | Must fail under `allow` mode |

### Adding a sample

1. Append an object `{ "cmd": "...", "via"?: "..." }` to the right array.
2. Run `npx vitest run tests/unit/security-corpus.test.ts`.
3. Prefer **must_block** for catastrophic cases; do not put common dev commands in must_block.

Origin: hardening roadmap item `cmd-hardblock-regression-corpus` (2026-07-12).
