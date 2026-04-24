# @kody-ade/kody-engine

`kody` — autonomous development engine. A single-session Claude Code agent behind a generic executor and declarative JSON executable profiles.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Consumer repo workflow (.github/kody.yml)  │  @kody comments · schedule · release PR merge
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ kody CLI (@kody-ade/kody-engine)           │
│   bin/kody.ts — entrypoint                  │
│   src/dispatch.ts — profile-driven routing  │
│   src/executor.ts — runs one profile        │
│   src/executables/<name>/                   │
│     profile.json · prompt.md · *.sh         │
│   src/scripts/*.ts — cross-cutting catalog  │
└─────────────────────────────────────────────┘
```

Every top-level command is its own auto-discovered executable. The router has **zero executable names hardcoded** — comment dispatch resolves the first token after `@kody` through `config.aliases`, then falls back to `config.defaultExecutable` / `config.defaultPrExecutable`. Drop a new `src/executables/<name>/` directory with a `profile.json` + `prompt.md` (+ any colocated `.sh`) and `kody <name>` starts working.

Executable directories contain **only** three kinds of files: `profile.json` (declaration), `prompt.md` (agent instructions), and `.sh` scripts (mechanical side-effect work). Cross-cutting TypeScript lives in [src/scripts/](src/scripts/); it can't import from `src/executables/` and can't branch on `profile.name`.

## Install in a consumer repo

```bash
npx -y -p @kody-ade/kody-engine@latest kody init
```

`kody init` scaffolds [kody.config.json](kody.config.schema.json), [.github/workflows/kody.yml](templates/kody.yml), per-scheduled-executable workflow files, and (if a UI is detected) `.kody/qa-guide.md` for `ui-review`. Idempotent — pass `--force` to overwrite.

Required repo secrets: at least one model provider key (e.g. `MINIMAX_API_KEY`, `ANTHROPIC_API_KEY`). Recommended: `KODY_TOKEN` PAT so kody's commits trigger downstream CI and can modify `.github/workflows/*`.

The consumer workflow listens on three triggers: `issue_comment` (for `@kody …` dispatch), `workflow_dispatch` (manual runs, chat mode, mission wake), and `pull_request: [closed]` (auto-finalizes a merged `release/vX.Y.Z` PR).

## Commands

```
# agent, writes code
kody run       --issue <N>                             # implement an issue end-to-end
kody fix       --pr    <N> [--feedback ...]            # apply PR review feedback
kody fix-ci    --pr    <N> [--run-id <ID>]             # fix failing CI
kody resolve   --pr    <N> [--prefer ours|theirs]      # merge default branch, resolve conflicts

# agent, read-only
kody plan      --issue <N>                             # research + implementation plan
kody research  --issue <N>                             # map repo context, surface gaps
kody review    --pr    <N>                             # structured diff review
kody ui-review --pr    <N> [--preview-url <URL>]       # UI review — browses preview via Playwright MCP
kody classify  --issue <N>                             # pick a flow type (feature/bug/spec/chore)

# flow orchestrators (no agent of their own — transition tables)
kody feature   --issue <N>                             # research → plan → run → review (→ fix)
kody bug       --issue <N>                             # plan → run → review (→ fix)
kody spec      --issue <N>                             # research → plan (no code, terminates at plan)
kody chore     --issue <N>                             # run → review (→ fix)

# missions & watches (scheduled, coordinate work via issue state)
kody mission-scheduler                                 # fans out to per-issue mission-tick
kody mission-tick      --issue <N>                     # one tick of a kody:mission issue
kody watch-stale-prs                                   # weekly stale-PR report

# deterministic (no agent)
kody sync      --pr    <N>                             # merge default into PR branch
kody release   --mode  prepare|finalize [--bump patch|minor|major] [--dry-run]
kody init      [--force]                               # scaffold consumer repo

# engine entrypoints
kody ci                                                # auto-dispatches from the GHA event
kody chat      [--session <id>]                        # dashboard-driven chat session
```

### Flow orchestrators

Each flow (`feature`, `bug`, `spec`, `chore`) is a declarative transition table: postflight entries dispatch the next executable based on `data.taskState.core.lastOutcome.type` via `runWhen`. No engine changes to add a new flow — drop a new `src/executables/<flow-name>/` with a different table. `classify` picks the flow for an unlabeled issue.

### Missions

A **mission** is a stateful, bounded goal expressed as a labeled GitHub issue (`kody:mission`). A **watch** is a stateless repeating loop. A **manager** is a mission whose job happens to be overseeing other missions. All three run on the same scheduled-executable substrate.

`mission-scheduler` wakes on cron (default `*/5 * * * *`) or empty `workflow_dispatch`, finds every open `kody:mission` issue, and calls `mission-tick` once per issue. The tick agent reads the issue body (human-owned prose) and a dedicated state comment (bot-owned JSON), decides the next step, and emits a fenced `kody-mission-next-state` block the postflight persists. Children are spawned via `gh workflow run kody.yml` (not `@kody` comments — the default `GITHUB_TOKEN` can dispatch workflows but can't post auto-triggering comments).

### `ui-review`

Drives the running preview deployment via the Playwright MCP server alongside the usual diff review.

- Preview URL: `--preview-url` → `$PREVIEW_URL` → `http://localhost:3000`. Unreachable → falls back to diff-only.
- Credentials: `.kody/qa-guide.md` (committed, scaffolded by `kody init` with `CHANGE_ME` placeholders).
- Auto-discovery: routes, roles, login/admin paths, Payload CMS collections, API routes, env vars — fed to the agent as context.

### `release`

- `--mode prepare` — bumps `package.json`, updates `CHANGELOG.md`, opens a `release/vX.Y.Z` PR. `--bump patch|minor|major` (default `patch`).
- `--mode finalize` — tags, pushes, runs `prepublishOnly` + `npm publish`, creates a GH release. Runs **automatically** when a `release/vX.Y.Z` PR is merged (via `pull_request: [closed]` in the consumer workflow); manual trigger still works.

## Profiles

A profile is declarative JSON + an adjacent `prompt.md`. See any directory under [src/executables/](src/executables/) for examples. Adding a new command = new directory + profile + prompt + any `.sh` scripts + registering any new shared TS utilities under [src/scripts/](src/scripts/). No executor, entry, or dispatch changes.

See [AGENTS.md](AGENTS.md) for the full architectural contract.
