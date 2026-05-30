# kody-engine — project context for agents

## What this is

`@kody-ade/kody-engine` (npm) is **kody**, an autonomous development engine. One `@kody` comment on a GitHub issue (or PR) runs Claude Code in CI, implements the change, commits, and opens or updates a PR.

Under the hood it is one **generic executor** running one of several **declarative executable profiles**. No multi-stage pipeline, no orchestration logic baked into the engine — each top-level command is its own single-purpose executable.

## Architecture (two layers, nothing else)

```
┌─────────────────────────────────────────────────────────────┐
│ Consumer repo .github/workflows/kody.yml                   │
│   (≈20 lines of YAML — minimal, stays dumb)                 │
│   trigger: @kody comment or workflow_dispatch              │
│   runs: npx @kody-ade/kody-engine@latest kody ci           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 1. Generic executor (src/executor.ts)                       │
│    - loads profile.json                                     │
│    - validates CLI args                                     │
│    - verifies CLI tool contracts                            │
│    - runs preflight scripts → agent → postflight scripts    │
│    - knows nothing about run/fix/review — it just executes  │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Executable profile (src/executables/<name>/profile.json) │
│    declarative JSON: inputs, allowed SDK tools, Claude Code │
│    features (hooks/skills/commands/subagents/plugins/MCP),  │
│    cliTools with install/verify/usage contracts, preflight  │
│    and postflight script lists with optional runWhen rules. │
│    Adjacent prompt file at prompt.md. One directory per     │
│    command: run, fix, fix-ci, resolve, review, plan,        │
│    orchestrator, release, watch-*, init.                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
        Fixed script catalog (src/scripts/*.ts)
        runFlow / fixFlow / fixCiFlow / resolveFlow / reviewFlow / …
        loadConventions / loadCoverageRules / composePrompt
        parseAgentResult / verify / checkCoverageWithRetry
        commitAndPush / ensurePr / postIssueComment
```

## Top-level commands

Each is its own auto-discovered executable. [src/dispatch.ts](src/dispatch.ts) picks one from the GHA event. CLI users can invoke any of them directly (`kody <command> …`).

### Vocabulary (canonical — read before the table)

The repo has carried several near-synonyms over time; these are the current, authoritative meanings. If a doc or comment uses a different word, it is stale.

- **executable** — one `src/executables/<name>/` directory; the atomic unit the executor runs. Every command below is one.
- **watch** — an executable with `role: "watch"`, `kind: "scheduled"`, and a `schedule` cron, fanned out by `dispatchScheduledWatches` on each wake. The *scheduler* itself runs no agent. Two exist: `job-scheduler`, `goal-scheduler`.
- **job** — a unit of intent expressed as a markdown file at `.kody/jobs/<slug>.md` (human-owned prose + frontmatter). `job-scheduler` ticks each file; `job-tick` (agent classifier) or `job-tick-scripted` (deterministic `tickScript:`) advances it. Per-slug state is persisted to a sidecar state file by the engine, not to a GitHub issue.
- **goal** — a stacked-PR state machine rooted at `.kody/goals/<id>/state.json`. `goal-scheduler` ticks each goal; `goal-tick` dispatches `@kody` on the next ready task stacked on the leaf PR, then finalizes the leaf into one review-ready PR. `qa-engineer` opens goals from QA findings. The engine never auto-merges.
- **manager** — *not an executable.* Prose for a job whose intent happens to be overseeing other jobs.
- **mission** — *dead term.* Renamed away; no `mission-*` executable exists. Do not use it.

### Commands (grouped by function)

**Issue → code (agent, end-to-end in one session)**

| Command | Input | Agent? | Triggered by |
|---|---|---|---|
| `run` | `--issue` | yes | `@kody` on an issue, or `workflow_dispatch` |
| `feature` | `--issue` | yes | `classify` routes here (feature/refactor) |
| `bug` | `--issue` | yes | `classify` routes here (reproduce → fix) |
| `chore` | `--issue` | yes | `classify` routes here (docs/dep-bump/chore) |
| `reproduce` | `--issue` | yes | write a failing test only — leaves it failing |

**Issue triage & planning**

| Command | Input | Agent? | Triggered by |
|---|---|---|---|
| `classify` | `--issue` | yes | `@kody` on an issue → dispatches the matching sub-orchestrator |
| `plan` | `--issue` | yes | `@kody plan` — read-only, posts a plan comment |
| `research` | `--issue` | yes | `@kody research` — read-only, maps context + gaps |
| `spec` | `--issue` | no (orchestrator) | sub-orchestrator for spec/RFC issues: research → plan (stop) |

**PR operations**

| Command | Input | Agent? | Triggered by |
|---|---|---|---|
| `fix` | `--pr`, `--feedback` | yes | `@kody` (or `@kody fix …`) on a PR comment (fallback) |
| `fix-ci` | `--pr`, `--run-id` | yes | `@kody fix-ci` on a PR |
| `resolve` | `--pr` | yes | `@kody resolve` — resolves merge conflicts |
| `review` | `--pr` | yes | `@kody review` — read-only, one comment |
| `ui-review` | `--pr`, `--preview-url` | yes | `@kody ui-review` — browses preview via Playwright |
| `qa-engineer` | `--url`, `--scope`, … | yes | free-form QA; opens findings as goals |
| `sync` | `--pr` | no | `@kody sync` — merge base into PR branch, push |
| `revert` | `--pr` | no | `git revert` one or more commits, fully mechanical |

**Scheduled watch substrate (scheduler runs no agent)**

| Command | Role / kind | Schedule | Notes |
|---|---|---|---|
| `job-scheduler` | watch / scheduled | `*/5 * * * *` | ticks every `.kody/jobs/<slug>.md` via `job-tick` |
| `job-tick` | primitive / oneshot | — | one classifier tick for one job file (agent) |
| `job-tick-scripted` | utility / oneshot | — | deterministic tick: runs the slug's `tickScript:` |
| `goal-scheduler` | watch / scheduled | `*/5 * * * *` | ticks every `.kody/goals/<id>/state.json` via `goal-tick` |
| `goal-tick` | primitive / oneshot | — | one stacked-PR tick (no agent) |

**Release stages (no agent, deterministic)**

| Command | Purpose |
|---|---|
| `release` | single-job release flow: prepare → wait CI → merge → publish → deploy → notify |
| `release-prepare` | bump version files, generate `CHANGELOG.md`, open the release PR |
| `release-publish` | tag the merged commit, run `publishCommand`, create the GH release |
| `release-deploy` | run `deployCommand` + `notifyCommand` after publish |

**Infra daemons (long-lived servers)**

| Command | Purpose |
|---|---|
| `serve` | start a LiteLLM proxy and optionally launch an editor pointed at it |
| `brain-serve` | HTTP server wrapping the chat loop, speaks the Brain SSE protocol |
| `pool-serve` | always-on warm-pool owner co-located on the litellm machine |
| `runner-serve` | idle HTTP server for a warm-pool one-shot runner |

**Bootstrap & live-test**

| Command | Purpose |
|---|---|
| `init` | scaffold a consumer repo (`kody.config.json` + workflow). No agent |
| `worker-ask` | ad-hoc one-shot: run a worker persona against an inline message |
| `plan-verify` | live-test: validates plugin/skill/hook wiring end-to-end |
| `probe-skill` | live-test: validates executable-local skill resolution |

### `run` — implement an issue end-to-end

The primary authoring path. Reads the issue, branches, writes code, commits, opens or updates a PR. Preflight: `runFlow` → `loadTaskState` → `resolveArtifacts` (pulls in a prior plan if present) → `loadConventions` → `loadCoverageRules` → `composePrompt`. Postflight: `parseAgentResult` → `requirePlanDeviations` → `verify` → `checkCoverageWithRetry` → `commitAndPush` → `ensurePr` → `postIssueComment` → `writeRunSummary` → `saveTaskState` → `mirrorStateToPr` → `advanceFlow`. Exit codes 0/1/2/3/4 communicate verify/commit/PR outcomes to the orchestrator.

### `plan` — research + implementation plan, no code

Read-only. Loads the issue, composes a planning prompt, lets the agent explore the repo, then persists the plan as an artifact on the task-state comment and posts it on the issue. No branches, no commits. Output feeds `run` via `resolveArtifacts` when both are chained.

### `research` — understand an issue, no plan prescribed

Sibling of `plan` for cases where the ask isn't yet clear. Agent maps repo context, surfaces clarifying questions and gaps, posts a research comment. Exists so you can ask "what's here?" without forcing the agent to leap to a plan. Supports delta mode: if a prior research comment exists on the issue, the agent outputs only the diff.

### `fix` — apply review feedback to a PR

Bare `@kody` on a PR defaults here (with feedback extracted from the comment body after stripping "fix"/"please"/"kindly"). `requireFeedbackActions` postflight enforces that the agent addressed at least one feedback point; `checkCoverageWithRetry` re-runs the agent up to N times if test-coverage gaps are detected.

### `fix-ci` — fix failing CI on a PR

Like `fix` but seeded with the failing CI run's logs instead of reviewer feedback. `--run-id` pins a specific run; omitted means "latest failing run on the PR head SHA".

### `resolve` — rebase/merge the base in and resolve conflicts

Merges the default branch into the PR branch. If the merge is clean, `skipAgent` is set in preflight and we go straight to `commitAndPush`. If conflicts exist, the agent resolves them, then the standard commit → push → ensurePr → comment chain runs.

### `sync` — merge default into PR, no agent

The no-conflict happy path of `resolve`, exposed as its own command. Never invokes the agent — `skipAgent` in preflight, just merge + push. Useful as a quick "pull in base" without spending agent turns.

### `review` — structured diff review

Read-only. Fetches the PR and its diff, composes a prompt with the two-pass reviewer checklist, agent writes a markdown review body, `postReviewResult` posts it verbatim. Verdict parsed from the agent output (`## Verdict: PASS | CONCERNS | FAIL`) drives the exit code and the `Action` recorded in task-state so `fix` can respond to it in an orchestrator flow.

### `ui-review` — UI/UX review via Playwright CLI

Extends the review surface by driving the running preview deployment with the Playwright CLI. Separate executable (not a mode flag on `review`) so the fast read-only `review` stays fast and `ui-review` carries the extra cost (preview URL, browser, optional creds) only when asked.

- **Preview URL** resolves from `--preview-url` → `$PREVIEW_URL` → `http://localhost:3000`. If unreachable, the agent is instructed to skip browsing and fall back to a diff-only review with the gap called out.
- **Credentials** are dashboard-managed and per-repo: the login username comes from the `LOGIN_USER` variable (`.kody/variables.json`), the password from the `LOGIN_PASSWORD` vault secret — which the dashboard mirrors into the repo's GitHub Actions secrets, so the engine reads it from `process.env` via `ALL_SECRETS` (the same path as every other secret; no vault decryption in CI). Hand-written scenarios/notes come from the company profile (`.kody/profile/*.md`). Assembled by the `loadQaContext` preflight.
- **QA auto-discovery** ([src/scripts/discoverQaContext.ts](src/scripts/discoverQaContext.ts) + [frameworkDetectors.ts](src/scripts/frameworkDetectors.ts)) scans routes, login/admin paths, roles, Payload CMS collections, API routes, and env templates. Output is serialized into the prompt as `{{qaContext}}`.
- **Playwright** is declared in the profile's `cliTools` with `installCommand: npx --yes playwright install --with-deps chromium`. Browser binaries are set up by preflight; if the consumer repo doesn't already have `@playwright/test`, the prompt instructs the agent to run `npm install -D @playwright/test` on first test failure. Throwaway specs live under `.kody/ui-review/` (gitignored by convention).
- **Verdict** is `PASS | CONCERNS | FAIL`. Agent's review comment is posted verbatim via the existing `postReviewResult` postflight (same machinery as `review`).

### `release` — version bump + publish, no agent

Two modes on a single flag:
- `--mode prepare` — bumps `package.json` + `src/entry.ts`, updates `CHANGELOG.md`, opens a release PR. `--bump patch|minor|major` picks the bump (default `patch`).
- `--mode finalize` — after the release PR is merged, tags `vX.Y.Z`, pushes, runs `prepublishOnly` + `npm publish`, creates a GH release.

`--dry-run` prints the planned actions without mutating anything. Deterministic — the agent is never invoked.

### `init` — scaffold a consumer repo

Writes `kody.config.json` (with package-manager-aware `quality.*` commands and owner/repo detected from `git remote`), `.github/workflows/kody.yml` (from the template), and per-scheduled-executable workflows (e.g. `kody-job-scheduler.yml`). Idempotent — skips anything already present unless `--force`. No agent.

### `job-scheduler` + `job-tick` — zero-code coordinator for file-defined jobs

A two-executable pair that lets a consumer define a stateful, recurring job *as a markdown file* — no per-job code, no PR to kody, no deploy. Used for digests, release pipelines, test-suite orchestration, pr-fleet supervision, or any multi-step flow that spans GitHub events. For what *job* / *goal* / *watch* / *manager* mean, see the **Vocabulary** glossary above — this section does not redefine them.

**The model.** Drop a file at `.kody/jobs/<slug>.md`: frontmatter on top (`every:` cadence, optional `tickScript:`, optional `mentions:`), human-owned prose below (the `## Job` intent). On every cron wake `job-scheduler` enumerates the job files, reads each one's frontmatter once, and ticks only the slugs whose `every:` interval is due. `done: true` in the slug's persisted state OR deleting the file stops future work. `kody init` copies the engine's built-in job files (e.g. [src/jobs/watch-stale-prs.md](src/jobs/watch-stale-prs.md)) into the consumer repo as starters.

- **`job-scheduler`** — `role: "watch"`, `kind: "scheduled"` (default cron `*/5 * * * *`). No agent. Preflight is `dispatchJobFileTicks`, which lists `.kody/jobs/<slug>.md`, gates each on its `every:` cadence, routes slugs carrying `tickScript:` frontmatter to `job-tick-scripted` and the rest to `job-tick`, and invokes the target once per due slug in-process.
- **`job-tick`** — `kind: oneshot`, required input `--job <slug>` (basename without `.md`), optional `--force` (bypass the cadence/prose guard — the dashboard's "Run now" button). Preflight `loadJobFromFile` → `composePrompt`. The agent decides the next step using only `gh` + `Read`; it never edits the working tree.
  - **`mentions:` frontmatter** — a comma-separated list of GitHub logins (stored without `@`) that this duty's output should `@`-mention, e.g. `mentions: aguyaharonyair, alice`. `loadJobFromFile` joins them into a ready-to-insert `@a @b` string and exposes it to the prompt as the `{{mentions}}` token (empty string when absent). This is the dashboard-managed replacement for ad-hoc `jq .github.operator` reads and hardcoded handles inside duty prompts — declare the recipients once in frontmatter and reference `{{mentions}}` in the prose. It emits a fenced `kody-job-next-state` block with `{ cursor, data, done }`, which postflight `parseJobStateFromAgentResult` → `writeJobStateFile` persists.
  - **`tools:` frontmatter — locked-toolbox mode** (v0.4.175). A duty that declares `tools: [...]` runs in a *locked toolbox*: the agent gets ONLY those tools (surfaced as `mcp__kody-duty__<name>`) plus `submit_state` — `Bash`, `Read`, and all shell access are revoked. This closes the bug class where a duty posted a raw `@kody <verb>` comment that the webhook receiver silently drops for bot authors, so the duty "succeeded" while its verb never ran. `jobFrontmatter` parses `tools:` as comma-separated names; `loadJobFromFile` validates them against the kody-duty palette, rewrites `profile.claudeCode.tools` to the locked allowlist, and swaps the prompt template to [src/executables/job-tick/prompts/locked.md](src/executables/job-tick/prompts/locked.md) (legacy `prompt.md` still serves Bash/gh duties unchanged). The in-process **kody-duty MCP server** ([src/dutyMcp.ts](src/dutyMcp.ts)) exposes six high-level intents — `list_prs_to_repair`, `sync_pr` / `fix_ci_pr` / `resolve_pr` (each dispatches via `gh workflow run kody.yml -f executable=<verb>`, never an `@kody` comment), `recommend_to_operator` (one comment with the operator mention substituted), and `read_ledger` (trust-ledger / sentinel-fenced manifest reader). `executor` forwards `enableDutyTool` / `dutyOperatorMention` / `dutyRepoSlug` to `runAgent`, which builds the server when the flag fires.
- **`job-tick-scripted`** — same `--job <slug>` input, no agent. Preflight `runTickScript` runs the slug's frontmatter `tickScript:` and parses next-state from its stdout; postflight `writeJobStateFile` persists. For fully deterministic jobs that don't need an LLM tick.

**State.** Per-slug job state is persisted by `writeJobStateFile` through a resolved backend (a state file — *not* a GitHub issue comment), and a write is skipped when the next state is structurally unchanged. Job *output* is whatever the prose asks for — e.g. `watch-stale-prs` writes a report at `.kody/reports/<slug>.md`.

**Intent vs. state separation.** The job file body is 100% human-owned — edit prose to steer the job (widen scope, change thresholds, abort). The bot never rewrites the body; it only advances the persisted state. Two surfaces, two owners, no collisions.

**Spawning children.** An agent tick spawns other kody runs via `gh workflow run kody.yml -f issue_number=<N>`. Works without a PAT because `workflow_dispatch` isn't subject to GitHub's anti-recursion safety on the default `GITHUB_TOKEN` — that's why we prefer it over posting `@kody` comments (which would silently not trigger a child run).

**Trigger routing.** `src/dispatch.ts` routes `schedule` events and empty `workflow_dispatch` through `dispatchScheduledWatches`, which fans out to every `role: "watch"`, `kind: "scheduled"` profile whose cron matches the wake window (today: `job-scheduler`, `goal-scheduler`). Consumers add exactly one line (`schedule: - cron:`) to their existing single `kody.yml` — no per-capability workflow files.

**Scale.** Fan-out is sequential in-process (one `runExecutable` call per due slug). Fine for small N; the scheduler itself always exits 0 — individual tick failures surface on the owning job, not as a cron failure.

### `plan-verify` — live-test harness for plugin wiring

Exists only to validate that the Claude Agent SDK is picking up bundled skills, slash commands, and hooks end-to-end. The profile declares `buildSyntheticPlugin` preflight which materializes a test plugin into a temp dir, and the prompt asks the agent to emit specific confirmation tokens (one per feature) that the test suite greps for. Not a user-facing command.

## Repo layout

```
src/
  executor.ts            — the single atomic runner
  profile.ts             — profile loader + validator
  tools.ts               — cliTools contract verifier
  dispatch.ts            — auto-detects mode from GHA event
  agent.ts               — Claude Code SDK invocation
  litellm.ts             — proxy lifecycle (for non-Anthropic providers)
  kody-cli.ts           — `kody ci` preflight (install, secrets, git identity)
  entry.ts               — CLI dispatcher (run/fix/fix-ci/resolve/ci/help)
  gha.ts                 — GHA helpers (run URL, 👀 reaction on trigger)
  {branch,commit,pr,verify,issue,coverage,prompt,format,config}.ts
  executables/
    types.ts
    run/        { profile.json, prompt.md }
    fix/        { profile.json, prompt.md }
    fix-ci/     { profile.json, prompt.md }
    resolve/    { profile.json, prompt.md }
    review/     { profile.json, prompt.md }
    ui-review/  { profile.json, prompt.md }
    plan/       { profile.json, prompt.md }
    release/ … job-scheduler/ … goal-scheduler/ … init/
  scripts/
    {runFlow,fixFlow,fixCiFlow,resolveFlow,reviewFlow}.ts
    {loadConventions,loadCoverageRules,composePrompt}.ts
    {discoverQaContext,frameworkDetectors,loadQaContext,resolvePreviewUrl}.ts  — ui-review preflights
    {parseAgentResult,verify,checkCoverageWithRetry}.ts
    {commitAndPush,ensurePr,postIssueComment}.ts
    index.ts             — registry that maps name → function
bin/kody.ts             — thin shebang wrapper
templates/kody.yml      — workflow to drop in consumer repos
tests/
  unit/                  — unit tests (~466 at time of writing)
  int/                   — integration tests (including ui-review prompt rendering)
  e2e/                   — CLI smoke tests
```

## Key invariants (do not break)

1. **The executor never references role-specific concepts.** No `run` / `fix` / `review` / `issue` / `pr` inside `executor.ts`. Only: profile, scripts, context, SDK call.
2. **Executable directories contain only `profile.json`, `prompt.md`, `.sh` scripts, and optional plugin-part subdirs — no TypeScript.** Allowed contents:
   - `profile.json` — declaration (inputs, tools, ordered preflight/postflight).
   - `prompt.md` — what the agent should do (markdown, consumed when the agent runs).
   - `*.sh` — mechanical side-effect work (git, fs, tool invocations). Colocated with the executable so everything about a command is in one directory.
   - `skills/<name>/`, `commands/<name>.md`, `agents/<name>.md`, `hooks/<name>.json` — optional Claude Agent SDK plugin parts that are specific to this one executable. The `buildSyntheticPlugin` preflight resolves names declared in `profile.claudeCode.{skills,commands,subagents,hooks}` from this directory first, then falls back to `src/plugins/`. Use the central `src/plugins/` catalog when a part is reused across multiple executables.

   `src/scripts/` is TypeScript — reserved for cross-cutting utilities used by multiple executables (`commitAndPush`, `composePrompt`, `verify`, `ensurePr`, `postIssueComment`). **Design smell**: if a piece of logic is too complex for shell AND specific to one executable, stop and redesign. Either simplify until shell expresses it cleanly, or promote into `src/scripts/` as a genuine cross-cutting utility. The middle ground — "executable-specific TypeScript tucked somewhere" — is what bloated the flow scripts and is explicitly banned. Adding a new command = drop a new `src/executables/<name>/` dir with its profile + prompt + any `.sh` scripts; register any new *shared* TS scripts in `src/scripts/`. Dispatch is profile-driven — no edits needed for issue- or PR-triggered commands.
3. **Scripts compose freely, one does one thing.** Each script is a small deterministic function. `runWhen` (dotted-path equality against context) is the only conditional primitive.
4. **Wrapper logic belongs in scripts, not inline.** No "wrapper layer" between executor and agent. `verify`/`commitAndPush`/`ensurePr`/`postIssueComment` etc. are all postflight scripts.
5. **The workflow YAML stays minimal.** Any new capability ships via npm, not via consumer YAML edits.
6. **Shared scripts stay generic — no branching on executable identity.** Anything in `src/scripts/` is cross-cutting and must treat `profile.name` as an opaque label (state keys, logs, action-type prefixes, `producedBy` tags). It may NOT branch on it (`if (profile.name === "resolve")`, `switch (profile.name)`, etc.). Per-executable behavior belongs in a profile-declared script/shell entry, not in a shared file. Enforced by [tests/unit/sharedScriptsInvariants.test.ts](tests/unit/sharedScriptsInvariants.test.ts).
7. **Shared scripts do not import from `src/executables/`.** Structural rule: if `src/scripts/*.ts` can't see executable code, it can't couple to it. Only `../executables/types.js` (the shared type contract) is allowed. Same test enforces this.
8. **`.kody/` write allowlist.** The agent may write only the `.kody/` subtrees named in `ALLOWED_PATH_PREFIXES` in [src/commit.ts](src/commit.ts) — currently `.kody/memory/` and `.kody/tasks/`. Every other `.kody/*` path is blocked by `commitAndPush`'s forbidden-path filter to keep agents out of runtime state during `run`/`fix`/`resolve`. Watches that open their own PR must check `commitResult.pushed === true` before calling `gh pr create`, not just `hasCommitsAhead`.

## Lifecycle catalog (refactor target)

> **Status:** documentation only. Code refactor sequenced in [docs/script-catalog-dsl-refactor.md](docs/script-catalog-dsl-refactor.md).
>
> **Why this exists:** today 35 of 69 registered scripts (~51%) in `src/scripts/` are referenced by exactly one executable — the `xxxFlow.ts` family is the worst offender. This violates invariant 2 ("cross-cutting utilities used by multiple executables"). The catalog below names the actual orchestration shapes hidden in those solo scripts so the next-step refactor (profile-level `lifecycle:` macros) has a concrete target.

### Shape 1 — `pr-branch` (migrated: 3 of 5)

**Members migrated:** `fix`, `fix-ci`, `run`.
**Members deferred (intentionally bespoke):** `resolve`, `revert`. See "Why not all five" below.

**Lifecycle config knobs** ([src/lifecycles/prBranch.ts](src/lifecycles/prBranch.ts)):
- `label: { name, color, description }` — required.
- `context: "task" | "ci-fix" | "minimal"` — controls which context-loading scripts populate `ctx.data`. Default `"task"`.
- `contextExtras: string[]` — additional context-loading scripts slotted in after `loadTaskState`. `run` uses this for `resolveArtifacts`.
- `sync: boolean` — include `syncFlow` (default `true`; `run` sets `false`).
- `verify: boolean` — include the `verify`/`checkCoverageWithRetry`/`abortUnfinishedGitOps` chain (default `true`).
- `advance: boolean` — include `advanceFlow` (default `true`; `fix-ci` sets `false`).
- `mirrorState: boolean` — include `mirrorStateToPr` between `saveTaskState` and `advanceFlow` (default `false`; `run` sets `true`).

**Per-executable solo scripts that survive after migration (still 1-executable):**
| Solo script | Executable | What it does (one line) |
| --- | --- | --- |
| `fixFlow` | `fix` | Open feedback PR branch, derive feedback text from latest PR review comment. |
| `fixCiFlow` | `fix-ci` | Open PR branch, attach failing CI run-id to context. |
| `runFlow` | `run` (also `reproduce`) | Open or create branch from issue, set up task state. *(Dual-use — already shared, leave as-is.)* |
| `requireFeedbackActions` | `fix` | Postflight assertion: feedback text must contain actionable items. |
| `requirePlanDeviations` | `run` | Postflight: if the agent deviated from the saved plan, require it to document why. |
| `resolveArtifacts` | `run` | Preflight: pull in artifacts from a prior `plan` run. Slotted via `contextExtras`. |

These remain as profile-declared steps. The `xxxFlow` bootstraps stay solo until phase-2 of cleanup reveals enough cross-executable overlap to extract a shared `openPrBranch` (PR validation + branch checkout + started-comment). Not premature-abstracted in this pass.

**Why not all five.** The original plan grouped `resolve` and `revert` with the pr-branch cluster based on `commitAndPush` + `ensurePr` overlap, but the deeper structure diverges:
- `resolve` is a merge operation — by design it skips the entire `verify`/`checkCoverageWithRetry`/`abortUnfinishedGitOps` chain (locked in by [tests/unit/executor.test.ts](tests/unit/executor.test.ts) `"resolve profile skips verify + checkCoverageWithRetry (merge op)"`), and it has its own postflight `stageMergeConflicts`. Fitting it would require a `verify: false` + custom postflight slot, and the result still wouldn't share the *intent* of the lifecycle (run agent, verify code, ship). Bespoke is the right answer.
- `revert` is no-agent (`maxTurns: 0`, no `tools`) and runs `revert.sh` deterministically. Its postflight uses `markFlowSuccess` + `recordOutcome` and flips `writeRunSummary`/`saveTaskState` order — almost nothing shared with the agent-driven shape. The `pr-branch` lifecycle is agent-shaped; forcing `revert` to fit would add an `agentless` flag whose only consumer is `revert`. Bespoke is the right answer.

If a future no-agent PR executable lands, a separate `lifecycle: "pr-mechanical"` is the path — *not* widening `pr-branch`.

### Shape 2 — `flow-state` (4 executables, no agent)

**Members:** `spec`, `bug`, `feature`, `chore`.

**Signature:** all 4 share `finishFlow`, `persistFlowState`, `loadIssueContext`, `setLifecycleLabel`, `skipAgent`. These are pre-implementation flow controllers — they classify an issue, persist intent state, and hand off to `run`.

**Per-executable solo scripts in this cluster:**
| Solo script | Executable |
| --- | --- |
| `startFlow` | `spec` (likely promotable — pattern fits the others) |
| `dispatch` | `spec` |

**Lifecycle:** `lifecycle: "flow-state"`. Probable that `startFlow` and `dispatch` collapse into the lifecycle module itself (shared between all four members but currently only wired into `spec`).

### Shape 3 — `goal-chain` — DEFERRED, goal-tick stays bespoke

**Member:** `goal-tick`.

**Per-executable solo scripts:** `loadGoalState`, `saveGoalState`, `commitGoalState`, `deriveGoalPhase`, `dispatchNextTask`, `finalizeGoal`, `handleAbandonedGoal`.

**Outcome:** the stop-condition fired. `goal-tick` is a state machine: `loadGoalState → handleAbandonedGoal (if abandoned) → deriveGoalPhase (if active) → finalizeGoal (if all-done) → dispatchNextTask (if ready) → saveGoalState → skipAgent`, then `commitGoalState` postflight. The `runWhen` clauses ARE the lifecycle. Moving these into a `lifecycle: "goal-chain"` module would relocate identical code — `goalFlow.ts` rebadged — not abstract anything. Mechanical enforcement (the modularity invariant in [tests/unit/sharedScriptsInvariants.test.ts](tests/unit/sharedScriptsInvariants.test.ts)) catches if any of these scripts accidentally get reused by another executable.

### Shape 4 — `release-stage` (4 executables, no agent)

**Members:** `release`, `release-prepare`, `release-deploy`, `release-publish`.

**Signature:** all 4 share `notifyTerminal`, `setCommentTarget`, `recordOutcome`, `skipAgent`, `advanceFlow`. These are the multi-stage release orchestrator. **Note:** [docs/release-merge-refactor.md](docs/release-merge-refactor.md) already proposes collapsing these into a single executable. **Sequencing:** ship release-merge-refactor *first*; if it lands, this shape disappears and no lifecycle work is needed here.

### Shape 5 — `init-bootstrap` (1 executable)

**Member:** `init`.

**Solo script:** `initFlow` (330 lines — writes consumer workflow template, creates initial config files).

**Lifecycle:** likely *no* lifecycle — `init` is a one-shot bootstrap, not a recurring flow. **Treat as residual** (phase 5 of refactor) and relocate to `src/scripts/executable/init/`.

### Shape 6 — `dispatch` (small, 3 executables)

**Members:** `classify`, `job-scheduler`, partly `spec`.

**Per-executable solo scripts:** `classifyByLabel`, `dispatchClassified`, `recordClassification` (classify); `dispatchJobFileTicks` (job-scheduler).

**Lifecycle:** probably **not worth abstracting** — these are too few and too divergent. Treat as residual.

### Residual (no cluster, ~10 scripts)

Genuinely executable-specific things that should relocate to `src/scripts/executable/<name>/` in phase 5 of the refactor:

`parseReproOutput`, `verifyReproFails` (reproduce); `resolvePreviewUrl`, `resolveQaUrl`, `discoverQaContext`, `loadQaContext`, `warmupMcp`, `createQaGoal` (qa-engineer/ui-review — but several are already dual-use, watch these); `diagMcp`, `postResearchComment` (research); `postPlanComment` (plan); `loadJobFromFile`, `runTickScript` (job-tick variants).

### How to use this catalog

- **Adding a new executable:** check whether it fits an existing shape. If yes, target the corresponding lifecycle. If no, ask whether the new shape generalises (3+ candidates means a new lifecycle is justified; 1–2 means leave it as residual).
- **Touching an existing solo script:** check this catalog before "promoting" anything new to `src/scripts/`. If it falls into a shape, the shape's lifecycle is the right target — not a new shared script.
- **Adding a new solo script:** add it to `KNOWN_SOLO_SCRIPTS` in [tests/unit/sharedScriptsInvariants.test.ts](tests/unit/sharedScriptsInvariants.test.ts) with the owning executable and a one-sentence reason. The test fails loudly if you skip this. If the script ends up referenced by ≥2 executables later, remove the allowlist entry (the test will tell you).

### Mechanical enforcement

[tests/unit/sharedScriptsInvariants.test.ts](tests/unit/sharedScriptsInvariants.test.ts) runs three modularity checks alongside the existing executor-name branching checks:

1. **No false positives in the allowlist.** A script the allowlist claims is solo, but profiles reference from ≥2 executables, fails — push it out of the allowlist (it's genuinely shared).
2. **No unaccounted solos.** A script referenced by exactly one executable that isn't in the allowlist fails — either add an entry with a reason, or generalise so a second executable consumes it.
3. **No stale entries.** An allowlisted script no longer referenced (or whose declared owner doesn't match reality) fails — clean up the allowlist.

The check counts **lifecycle-expanded references** (a profile that opts into `lifecycle: "pr-branch"` is counted as referencing every script the lifecycle injects), so promoting a script into a lifecycle bookend doesn't silently turn it into a solo.

## Version history / split context

- Legacy engine lives at **`aharonyaircohen/Kody-Engine-Lite`** under the package name `@kody-ade/engine`, frozen at v0.7.14. Do not add features there.
- This repo (`aharonyaircohen/kody-engine`, package `@kody-ade/kody-engine`) is a clean split — only the executor + Build executable + scripts survived the move. No `src-v2/`, no `kody-lean`, no 7-stage pipeline history.
- Current version: see `package.json` (started at `0.2.0` because `0.1.x` was taken on npm by a deprecated predecessor). **Patches only** — do not bump minor/major without explicit ask.

## Tester / live-test repo

**`aharonyaircohen/Kody-Engine-Tester`** is the live-test bed. It is a Next.js + Payload CMS LMS with intentional pre-existing quality-gate failures (TypeScript errors, time-sensitive tests, missing Postgres) so verify drafts are informative, not scary.

- Its `.github/workflows/kody.yml` pins an exact `@kody-ade/kody-engine@X.Y.Z` version via `npx`. Version bumps do **not** propagate automatically — the tester's workflow must be resynced from the new template to pick up a new engine.
- Its `kody.config.json` declares `agent.model`, quality commands, and `testRequirements` (route.ts files require a sibling `route.test.ts`).
- To live-test a change: publish the new kody version, comment `@kody` on a fresh issue there (or PR comment for fix/fix-ci/resolve).

## How to proceed on a new session

1. Read the relevant code in `src/` — start with `executor.ts` and the profile directories under `src/executables/`.
2. For feature requests: is it an **existing profile** change (tweak one command), a **new profile** (new top-level command — new dir under `src/executables/`), a **script** change (new postflight hook), or an **executor** change (new conditional primitive / new SDK surface)? 90% of the time it's scripts or a profile.
3. `pnpm typecheck && pnpm test && pnpm test:e2e` before any commit.
4. Release flow: bump patch in `package.json`, update the `@kody-ade/kody-engine@X.Y.Z` pin in `templates/kody.yml` to the same version, commit, tag `vX.Y.Z`, `git push --follow-tags`, `npm publish --access public`. (`src/entry.ts` reads the version from `package.json` at runtime — no separate string to update.)
5. Live-test on the tester before declaring success.

## External dependencies worth knowing

- **`@anthropic-ai/claude-agent-sdk`** — the Claude Code SDK the executor calls via `runAgent`.
- **LiteLLM** — started by `src/litellm.ts` when the configured model isn't Anthropic-native.
- **`gh` CLI** — the only way kody talks to GitHub. Never use the raw API directly in new scripts.
