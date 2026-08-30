# Contributing to Enhanced Terminal MCP

Thanks for your interest in contributing! Issues and pull requests of all sizes
are welcome.

**Please open an issue before investing significant work** — especially for new
tools, behavior changes to existing tools, or anything touching the security
layer. A short discussion up front saves everyone time.

## Development setup

- **Node.js ≥ 22.13** for development (required by the pinned **pnpm 11.21.0**,
  which is selected via the `packageManager` field; `corepack enable` provides
  the exact version). The published npm package itself runs on Node.js ≥ 20.
- `pnpm install` — keep lifecycle scripts enabled: `postinstall` applies a
  pinned compatibility patch to `@modelcontextprotocol/sdk`
- `pnpm run build` — clean-compiles TypeScript to `build/`

## Verifying changes

```bash
pnpm exec tsc --noEmit   # type-check
pnpm run lint            # Biome check (src/ and tests/)
pnpm test                # unit + e2e suites (vitest)
pnpm run gate            # the canonical release gate — run this before opening a PR
```

If you changed anything under `src/`, run `pnpm run build` first: the e2e and
latency suites spawn `build/index.js` as a real subprocess. Shell resolution,
archiving, and search engines are platform-specific, so please state which
platforms (Windows / Linux / macOS) you tested on.

## Conventions

- TypeScript ESM; local imports carry the `.js` extension; Node builtins use
  the `node:` prefix
- Biome is the single formatter/linter (`pnpm run format`); double quotes,
  semicolons
- Every tool handler is wrapped with `wrapHandler` and returns the shared
  `ToolResult` protocol
- Use `logger` (writes to stderr) — never `console.log` in library code
- Unit tests live in `tests/unit/` (never beside source files); e2e lives in
  `tests/`; test temp data goes under the project-internal `.etmcp/test-tmp`
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `refactor:`)

## Security invariants — read before touching these

The following are load-bearing safety behavior. Changing them requires an
explicit maintainer conversation in an issue first:

- `src/security.ts`: the dangerous/hard-block patterns and the path/URL hard
  floor
- `src/safeguard.ts`: safety-mode logic. `hardBlock` is the unclosable baseline
  and stays active in every mode, including `off`
- Tool input/output contracts and the error-code set
- Dependency pins: `@modelcontextprotocol/sdk` exact `1.29.0`
  (postinstall-patched), zod v3. **No new runtime dependencies** without an
  agreed evaluation

Report vulnerabilities privately per [SECURITY.md](./SECURITY.md) — never in a
public issue.

## Pull requests

- Keep the scope minimal and reference the linked issue
- Include the verification you ran (ideally `pnpm run gate`) and the
  platform(s) tested
- Update `README.md` / `CHANGELOG.md` when user-visible behavior, environment
  variables, or the tool surface change

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE) and follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).

---

> This project makes no guarantees about update frequency, issue resolution timelines, or long-term support.
