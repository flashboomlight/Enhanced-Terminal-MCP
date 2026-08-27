---
doc_type: spike
slug: deps-zod-v4-spike
roadmap: remaining-hardening
roadmap_item: deps-zod-v4-spike
status: draft
created: 2026-07-12
---

# Spike: zod v4 migration go/no-go

## Current

- App: `zod@^3.25.67` (resolved ~3.25.76)
- `@modelcontextprotocol/sdk@1.29.0` peer: `zod: ^3.25 \|\| ^4.0`

## Decision today

**Stay on zod v3** until this spike is re-run with a green migration PR.
Authority: `codestable/compound/2026-07-12-decision-zod-v3-remain.md`.

## Migration checklist (when attempted)

1. Read zod v4 migration guide (breaking: error map, `z.nativeEnum`, string formats, etc.).
2. Bump zod to v4 in a branch; run `npx tsc --noEmit` and fix all tool schemas.
3. Run full `npm test` + `npm run test:latency`.
4. Verify MCP tool list still publishes JSON Schema with `required: []` patch intact.
5. Measure bundle/install size if relevant.

## Go criteria

- Zero test regressions
- No SDK peer conflict
- Documented breakages for external consumers (if any)

## No-go criteria

- SDK path requires dual zod major support hacks
- Large silent behavior change in validation messages used by LLMs

## Recommendation (2026-07-12)

**No-go for immediate merge.** Schedule only if v3 loses security support or SDK drops v3.

## Exit

When go: supersede `decision-zod-v3-remain` and implement in a dedicated feature, not mixed with security PRs.
