## Summary

<!-- What changed and why. Link the issue: Fixes #123 -->

## Verification

<!-- What you ran and on which platform(s), e.g. `pnpm run gate` passed on Windows 11 + Ubuntu 24.04 -->

## Contract, security & docs

- [ ] No tool input/output schema or error-code changes — or they are described above and reflected in README/CHANGELOG
- [ ] Security invariants untouched (`src/security.ts` hard floor, `hardBlock`, safeguard modes) — or explicitly discussed in the linked issue
- [ ] No new runtime dependencies
- [ ] `README.md` / `CHANGELOG.md` updated if user-visible behavior changed
- [ ] `pnpm run build` + test suites re-run after any `src/` change (e2e/latency spawn `build/index.js`)
