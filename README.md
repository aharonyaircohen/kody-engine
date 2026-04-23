# @kody-ade/kody-engine

`kody` — autonomous development engine. A single-session Claude Code agent behind a generic executor and declarative JSON executable profiles.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Consumer repo workflow (.github/kody.yml)  │  triggers on @kody comments
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ kody CLI (@kody-ade/kody-engine)           │
│   bin/kody.ts — parses argv                │
│   src/executor.ts — runs one profile        │
│   src/executables/<name>/profile.json       │
│   src/scripts/*.ts — named hook catalog     │
└─────────────────────────────────────────────┘
```

Every top-level command is its own auto-discovered executable (`run`, `fix`, `fix-ci`, `resolve`, `review`, `sync`, `plan`, `plan-verify`, `orchestrator`, `release`, `watch-*`, `init`). The router has no hardcoded command switch beyond `ci`/`help`/`version` — drop a new `src/executables/<name>/` directory with a `profile.json` + `prompt.md` and `kody <name>` starts working. The executor knows nothing about any specific command.

## Install in a consumer repo

1. Copy `templates/kody.yml` to `.github/workflows/kody.yml`.
2. Add `agent.model` to `kody.config.json` (see `kody.config.schema.json`).
3. Secrets on the repo:
   - At least one model key (e.g. `MINIMAX_API_KEY`, `ANTHROPIC_API_KEY`)
   - Optional `KODY_TOKEN` PAT if you want kody's pushes to trigger downstream CI

## Commands

```
# issue-triggered, agent writes code
kody run       --issue <N>                              # implement an issue end-to-end (branch, code, PR)

# issue-triggered, agent read-only (no commits)
kody plan      --issue <N>                              # produce a plan artifact for run
kody research  --issue <N>                              # map repo context, surface questions/gaps

# PR-triggered, agent writes code
kody fix       --pr    <N> [--feedback ...]             # apply PR review feedback
kody fix-ci    --pr    <N> [--run-id <ID>]              # fix failing CI
kody resolve   --pr    <N>                              # merge default branch in, resolve conflicts

# PR-triggered, agent read-only
kody review    --pr    <N>                              # structured diff review (fast, diff only)
kody ui-review --pr    <N> [--preview-url <URL>]        # UI/UX review — browses preview via Playwright

# no agent (deterministic)
kody sync      --pr    <N>                              # merge default branch into PR branch
kody release   --mode  prepare|finalize [--bump patch|minor|major] [--dry-run]
kody init      [--force]                                # scaffold consumer repo
kody orchestrate --issue <N> [--flow plan-build-review] # chain plan → run → review → fix

# engine entrypoints
kody ci        --issue <N>                              # CI preflight + auto-dispatch from GHA event
kody chat      [--session <id>]                         # dashboard-driven chat session
```

### `ui-review`

`ui-review` adds UI/UX verification to the review surface. It runs the usual diff-based review AND drives the running preview deployment via the Playwright CLI — writing a throwaway spec under `.kody/ui-review/`, running it, capturing screenshots, and folding the observed behavior into the review verdict.

- Preview URL resolution: `--preview-url` flag → `$PREVIEW_URL` → `http://localhost:3000`.
- Credentials: committed in `.kody/qa-guide.md` (scaffolded by `kody init` when a UI is detected, with `CHANGE_ME` placeholders). The agent reads the guide and uses any credentials it finds.
- Auto-discovery: routes, roles, login page, admin path, Payload CMS collections, API routes, env vars — fed to the agent so it knows *what* to browse without you spelling it out.
- Falls back to a diff-only review when the preview URL is unreachable.

`kody chat` reads `.kody/sessions/<id>.jsonl`, runs one agent turn, appends
the reply, and writes `chat.message` + `chat.done` events to
`.kody/events/<id>.jsonl` (plus optional HTTP push to a dashboard ingest URL).
Inputs can come from flags or env (`SESSION_ID`, `INIT_MESSAGE`, `MODEL`,
`DASHBOARD_URL`) — the yaml template passes the latter.

## Profiles

A profile is declarative JSON + an adjacent `prompt.md`. See any directory under `src/executables/` for examples. Adding a new command = new directory + profile + prompt + registering any new scripts under `src/scripts/`. No executor, entry, or dispatch changes.
