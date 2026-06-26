<!-- Thanks for contributing to kody! -->

## What & why

<!-- One sentence: what does this change and why. -->

## Type

- [ ] Profile change (tweak one executable)
- [ ] New executable (`src/executables/<name>/`)
- [ ] Shared script (`src/scripts/`)
- [ ] Executor / dispatch change
- [ ] Docs only
- [ ] Release

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] `pnpm test:e2e` passes (if behavior changed)
- [ ] No new TypeScript inside `src/executables/` (invariant 2)
- [ ] No `profile.name` branching in `src/scripts/` (invariant 6)
- [ ] YAML untouched unless this is a release (invariant 5)

## Notes for reviewers

<!-- Anything non-obvious, trade-offs, or follow-ups. -->
