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

`kody init` scaffolds [kody.config.json](kody.config.schema.json), [.github/workflows/kody.yml](templates/kody.yml), and per-scheduled-executable workflow files. Idempotent — pass `--force` to overwrite.

Required repo secrets: at least one model provider key (e.g. `MINIMAX_API_KEY`, `ANTHROPIC_API_KEY`). Recommended: `KODY_TOKEN` PAT so kody's commits trigger downstream CI and can modify `.github/workflows/*`.

The consumer workflow listens on three triggers: `issue_comment` (for `@kody …` dispatch), `workflow_dispatch` (manual runs, chat mode, job wake), and `pull_request: [closed]` (auto-finalizes a merged `release/vX.Y.Z` PR).

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
kody qa-engineer [--url <URL>] [--scope ...]           # free-form QA — browses, opens findings as goal task issues
               [--goal <id>] [--issue <N>]
               [--auth-profile <storageState.json>]
kody classify  --issue <N>                             # pick a flow type (feature/bug/spec/chore)

# flow orchestrators (no agent of their own — transition tables)
kody feature   --issue <N>                             # research → plan → run → review (→ fix)
kody bug       --issue <N>                             # plan → run → review (→ fix)
kody spec      --issue <N>                             # research → plan (no code, terminates at plan)
kody chore     --issue <N>                             # run → review (→ fix)

# jobs & watches (scheduled, coordinate work via issue state)
kody job-scheduler                                 # fans out to per-issue job-tick
kody job-tick      --issue <N>                     # one tick of a kody:job issue
kody watch-stale-prs                                   # weekly stale-PR report
kody memorize                                          # daily vault wiki update from recent PRs

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

### Jobs

A **job** is a stateful, bounded goal expressed as a labeled GitHub issue (`kody:job`). A **watch** is a stateless repeating loop. A **manager** is a job whose job happens to be overseeing other jobs. All three run on the same scheduled-executable substrate.

`job-scheduler` wakes on cron (default `*/5 * * * *`) or empty `workflow_dispatch`, finds every open `kody:job` issue, and calls `job-tick` once per issue. The tick agent reads the issue body (human-owned prose) and a dedicated state comment (bot-owned JSON), decides the next step, and emits a fenced `kody-job-next-state` block the postflight persists. Children are spawned via `gh workflow run kody.yml` (not `@kody` comments — the default `GITHUB_TOKEN` can dispatch workflows but can't post auto-triggering comments).

### `ui-review`

PR-bound UI review. Drives the running preview deployment via the Playwright MCP server alongside the usual diff review, posts one structured review comment.

- Preview URL: `--preview-url` → `$PREVIEW_URL` → `http://localhost:3000`. Unreachable → falls back to diff-only.
- Credentials: dashboard-managed, per-repo — login username from the `LOGIN_USER` variable (`.kody/variables.json`), password from the `LOGIN_PASSWORD` vault secret (`.kody/secrets.enc`). Hand-written scenarios/notes come from the company profile (`.kody/profile/*.md`).
- Auto-discovery: routes, roles, login/admin paths, Payload CMS collections, API routes, env vars — fed to the agent as context.

For free-form QA passes (no diff, no PR), see [`qa-engineer`](#qa-engineer) below.

### `qa-engineer`

Free-form QA pass. Browses a running site with Playwright MCP, exercises UI states (happy / empty / error / loading / mobile / a11y), and turns findings into a kody goal whose tasks are individually triageable, severity-labelled bug issues. Read-only on the repo (no commits except the goal's own `state.json`).

```bash
# broad smoke against the project's QA_URL variable
kody qa-engineer

# focused pass; opens a new qa-<scope>-<date> goal + N task issues
kody qa-engineer --scope "checkout flow"

# attach findings to an existing goal (resolves URL from goal-<id>'s Vercel deployment)
kody qa-engineer --goal admin-chat-memory-recall-ui

# explicit URL overrides everything; useful for testing a deployed PR preview
kody qa-engineer --url https://my-feature-branch.vercel.app --scope "search UX"

# pre-authenticated session via committed Playwright storageState
kody qa-engineer --scope "admin" --auth-profile .kody/qa-storage-state.json

# PASS verdicts (no findings) skip goal creation; --issue routes the report to a comment
kody qa-engineer --scope "smoke" --issue 1234
```

**URL resolution chain.** `resolveQaUrl` walks the chain in order; first non-empty source wins:

1. `--url <URL>` — explicit
2. `--goal <id>` → latest successful Vercel deployment for the `goal-<id>` branch (via `repos/.../deployments?ref=goal-<id>` + statuses)
3. `$PREVIEW_URL` env var
4. `QA_URL` variable in `.kody/variables.json` (per-repo, dashboard-managed)
5. error — no localhost defaults; CI has no localhost to fall back to.

Configure the per-repo default via the dashboard's variables store (`.kody/variables.json`), key `QA_URL` — e.g. `https://dev.example.com`.

**Output modes.**

| Trigger | What happens |
|---|---|
| Findings + no `--goal` | Appends a new `qa-<scope>-<date>` entry to the `kody:goals-manifest` issue (description = full report markdown). Opens N task issues, each labelled `goal:<id>` + `severity:Px` + `kody:qa-finding`. Writes `.kody/goals/<id>/state.json` (state: `active`) and pushes — `goal-scheduler` picks it up next tick. |
| Findings + `--goal <id>` | Skips manifest body mutation (the existing goal owns its description). Posts the report markdown as a comment on the manifest issue. Opens N task issues with `goal:<id>` labels. |
| Zero findings + `--issue <N>` | Posts the report as a comment on issue N. No goal touched. |
| Zero findings + no `--issue` | Opens a single `kody:qa-finding`-labelled record issue with the full report body. |

**Agent-emitted JSON contract.** The prompt requires the agent's final message to end with a machine-readable block:

```
<!-- KODY_QA_REPORT_JSON
```json
{
  "findings": [
    {
      "severity": "P0|P1|P2|P3",
      "title": "Short imperative — becomes the issue title",
      "route": "/admin/...",
      "steps": "1. ...\n2. ...",
      "expected": "...",
      "actual": "...",
      "evidence": ".kody/qa-reports/<scope>/<finding>.png"
    }
  ]
}
```
-->
```

If the block is missing or malformed, the postflight falls back to single-issue mode and logs a warning. Severity rubric: P0 blocks core flow / data loss / security → verdict FAIL; P1 broken non-critical feature → typically FAIL; P2 degraded UX → typically CONCERNS; P3 polish → doesn't affect verdict.

**GHA usage.** Trigger from any issue comment (auto-dispatched by the existing kody.yml workflow):

```
@kody qa-engineer --goal add-per-user-chat-memory-recall-ui --scope "memory recall UI"
```

…or via `workflow_dispatch`:

```bash
gh workflow run kody.yml -F executable=qa-engineer \
  -F args="--goal admin-chat-memory-recall-ui --scope 'admin chat'"
```

**Auto-discovery & credentials.** Same as `ui-review`: `discoverQaContext` scans the repo for routes/roles/admin path/Payload collections/env vars; `loadQaContext` reads the dashboard-managed login username (`LOGIN_USER` variable), password (`LOGIN_PASSWORD` vault secret), and hand-written scenarios/notes (`.kody/profile/*.md`). The agent only logs in if a route under test requires it.

**Artifacts.** Screenshots and DOM snapshots go to `.kody/qa-reports/<scope-slug>/`; the Playwright MCP also writes to `.playwright-mcp/`. Both should be in `.gitignore` and `.prettierignore` — `kody init` doesn't yet scaffold these, add them manually:

```gitignore
.kody/qa-reports/
.playwright-mcp/
```

```
.kody/**
.playwright-mcp/**
```

### `memorize` — vault wiki

A scheduled watch (cron `0 3 * * *`) that synthesizes recently merged PRs into a markdown knowledge base at `.kody/vault/` and opens a PR with the changes. Pages are entity-centric (`architecture/`, `conventions/`, `decisions/`, `components/`), not per-PR logs. Future kody runs see the relevant pages via the `loadVaultContext` preflight, which is wired into `run` / `fix` / `resolve` and exposes them as `{{vaultContext}}` in the prompt.

To enable in a consumer repo: ensure `.gitignore` un-ignores the vault if `.kody/*` is otherwise ignored:

```gitignore
.kody/*
!.kody/vault/
!.kody/vault/**
```

### `release`

- `--mode prepare` — bumps `package.json`, updates `CHANGELOG.md`, opens a `release/vX.Y.Z` PR. `--bump patch|minor|major` (default `patch`).
- `--mode finalize` — tags, pushes, runs `prepublishOnly` + `npm publish`, creates a GH release. Runs **automatically** when a `release/vX.Y.Z` PR is merged (via `pull_request: [closed]` in the consumer workflow); manual trigger still works.

## Profiles

A profile is declarative JSON + an adjacent `prompt.md`. See any directory under [src/executables/](src/executables/) for examples. Adding a new command = new directory + profile + prompt + any `.sh` scripts + registering any new shared TS utilities under [src/scripts/](src/scripts/). No executor, entry, or dispatch changes.

See [AGENTS.md](AGENTS.md) for the full architectural contract.
