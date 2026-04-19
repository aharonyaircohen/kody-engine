# @kody-ade/kody-engine

`kody2` — autonomous development engine. A single-session Claude Code agent behind a generic executor and declarative JSON executable profiles.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Consumer repo workflow (.github/kody2.yml)  │  triggers on @kody2 comments
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ kody2 CLI (@kody-ade/kody-engine)           │
│   bin/kody2.ts — parses argv                │
│   src/executor.ts — runs one profile        │
│   src/executables/build/profile.json        │
│   src/scripts/*.ts — named hook catalog     │
└─────────────────────────────────────────────┘
```

`run`/`fix`/`fix-ci`/`resolve` are four modes of the same `build` executable, selected by `args.mode` via `runWhen` on preflight script entries. Executor knows nothing about any specific mode.

## Install in a consumer repo

1. Copy `templates/kody2.yml` to `.github/workflows/kody2.yml`.
2. Add `agent.model` to `kody.config.json` (see `kody.config.schema.json`).
3. Secrets on the repo:
   - At least one model key (e.g. `MINIMAX_API_KEY`, `ANTHROPIC_API_KEY`)
   - Optional `KODY_TOKEN` PAT if you want kody2's pushes to trigger downstream CI

## Commands

```
kody2 run     --issue <N>                  # implement an issue
kody2 fix     --pr    <N> [--feedback ...]  # apply PR review feedback
kody2 fix-ci  --pr    <N> [--run-id <ID>]   # fix failing CI
kody2 resolve --pr    <N>                   # merge default branch in, resolve conflicts
kody2 ci      --issue <N>                   # CI preflight + run
```

## Profiles

A profile is declarative JSON + an adjacent prompt. See `src/executables/build/profile.json`. Adding a new role = new profile + new prompt + registering any new scripts under `src/scripts/`. No executor changes.
