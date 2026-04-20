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
│   src/executables/<name>/profile.json       │
│   src/scripts/*.ts — named hook catalog     │
└─────────────────────────────────────────────┘
```

Every top-level command is its own auto-discovered executable (`run`, `fix`, `fix-ci`, `resolve`, `review`, `plan`, `orchestrator`, `release`, `watch-*`, `init`). The router has no hardcoded command switch beyond `ci`/`help`/`version` — drop a new `src/executables/<name>/` directory with a `profile.json` + `prompt.md` and `kody2 <name>` starts working. The executor knows nothing about any specific command.

## Install in a consumer repo

1. Copy `templates/kody2.yml` to `.github/workflows/kody2.yml`.
2. Add `agent.model` to `kody.config.json` (see `kody.config.schema.json`).
3. Secrets on the repo:
   - At least one model key (e.g. `MINIMAX_API_KEY`, `ANTHROPIC_API_KEY`)
   - Optional `KODY_TOKEN` PAT if you want kody2's pushes to trigger downstream CI

## Commands

```
kody2 run     --issue <N>                   # implement an issue
kody2 fix     --pr    <N> [--feedback ...]  # apply PR review feedback
kody2 fix-ci  --pr    <N> [--run-id <ID>]   # fix failing CI
kody2 resolve --pr    <N>                   # merge default branch in, resolve conflicts
kody2 review  --pr    <N>                   # read-only structured PR review
kody2 ci      --issue <N>                   # CI preflight + run
```

## Profiles

A profile is declarative JSON + an adjacent `prompt.md`. See any directory under `src/executables/` for examples. Adding a new command = new directory + profile + prompt + registering any new scripts under `src/scripts/`. No executor, entry, or dispatch changes.
