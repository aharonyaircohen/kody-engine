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

Each is its own auto-discovered executable. [src/dispatch.ts](src/dispatch.ts) picks one from the GHA event.

| Command                           | Input                    | Agent? | Triggered by                                                 |
|-----------------------------------|--------------------------|--------|--------------------------------------------------------------|
| `run`                             | `--issue`                | yes    | `@kody` on an issue, or `workflow_dispatch`                 |
| `plan`                            | `--issue`                | yes    | `@kody plan` on an issue                                    |
| `research`                        | `--issue`                | yes    | `@kody research` on an issue                                |
| `fix`                             | `--pr`, `--feedback`     | yes    | `@kody` (or `@kody fix …`) on a PR comment (fallback)      |
| `fix-ci`                          | `--pr`, `--run-id`       | yes    | `@kody fix-ci` on a PR                                      |
| `resolve`                         | `--pr`                   | yes    | `@kody resolve` on a PR                                     |
| `review`                          | `--pr`                   | yes    | `@kody review` on a PR (read-only, diff only)               |
| `ui-review`                       | `--pr`, `--preview-url`  | yes    | `@kody ui-review` on a PR (browses preview via Playwright)  |
| `sync`                            | `--pr`                   | no     | `@kody sync` on a PR                                        |
| `orchestrator-plan-build-review`  | `--issue`, `--flow`      | no     | `@kody orchestrate` on an issue                             |
| `release`                         | `--mode`, `--bump`       | no     | CLI or `workflow_dispatch`                                   |
| `init`                            | `--force`                | no     | CLI (`kody init` in a fresh consumer repo)                  |
| `watch-stale-prs`                 | (none)                   | no     | scheduled (`0 8 * * MON`)                                    |
| `plan-verify`                     | `--issue`                | yes    | CLI (live-test — validates plugin/skill/hook wiring)         |

CLI users can invoke any of these directly (`kody <command> …`).

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
- **Credentials** live in `.kody/qa-guide.md` — a committed file in the consumer repo. `kody init` scaffolds a starter with `CHANGE_ME` placeholders and pre-filled role rows (inferred from discovered enums/select fields); the maintainer fills in real preview creds and commits. No GitHub secrets required.
- **QA auto-discovery** ([src/scripts/discoverQaContext.ts](src/scripts/discoverQaContext.ts) + [frameworkDetectors.ts](src/scripts/frameworkDetectors.ts)) scans routes, login/admin paths, roles, Payload CMS collections, API routes, and env templates. Output is serialized into the prompt as `{{qaContext}}`.
- **Playwright** is declared in the profile's `cliTools` with `installCommand: npx --yes playwright install --with-deps chromium`. Browser binaries are set up by preflight; if the consumer repo doesn't already have `@playwright/test`, the prompt instructs the agent to run `npm install -D @playwright/test` on first test failure. Throwaway specs live under `.kody/ui-review/` (gitignored by convention).
- **Verdict** is `PASS | CONCERNS | FAIL`. Agent's review comment is posted verbatim via the existing `postReviewResult` postflight (same machinery as `review`).

### `orchestrator-plan-build-review` — deterministic flow controller

Chains `plan` → `run` → `review` → (`fix` on CONCERNS/FAIL) with no agent of its own — the postflight entries ARE the transition table, evaluated top-to-bottom via `runWhen` on `data.taskState.core.lastOutcome.type`. `dispatch` postflight spawns the next executable via a self-re-entry comment; `finishFlow` terminates when a success or hard-fail action is reached. Adding a new flow shape = new `orchestrator-<flow>/` directory with a different transition table, no engine changes.

### `release` — version bump + publish, no agent

Two modes on a single flag:
- `--mode prepare` — bumps `package.json` + `src/entry.ts`, updates `CHANGELOG.md`, opens a release PR. `--bump patch|minor|major` picks the bump (default `patch`).
- `--mode finalize` — after the release PR is merged, tags `vX.Y.Z`, pushes, runs `prepublishOnly` + `npm publish`, creates a GH release.

`--dry-run` prints the planned actions without mutating anything. Deterministic — the agent is never invoked.

### `init` — scaffold a consumer repo

Writes `kody.config.json` (with package-manager-aware `quality.*` commands and owner/repo detected from `git remote`), `.github/workflows/kody.yml` (from the template), per-scheduled-executable workflows (e.g. `kody-watch-stale-prs.yml`), and when a UI is detected (`src/app/`, `app/`, or `pages/` exists) a `.kody/qa-guide.md` stub for `ui-review`. Idempotent — skips anything already present unless `--force`. No agent.

### `watch-stale-prs` — scheduled PR hygiene report

`kind: scheduled` with cron `0 8 * * MON`. `kody init` auto-generates `.github/workflows/kody-watch-stale-prs.yml` to drive it. Lists open PRs untouched for N days and posts a summary issue. No agent — all deterministic.

### `mission-scheduler` + `mission-tick` — zero-code coordinator for issue-scoped missions

A two-executable pair that lets a consumer define a stateful goal *as a GitHub issue* — no per-mission code, no PR to kody, no deploy. Used for release pipelines, test-suite orchestration, pr-fleet supervision, or any multi-step flow that spans GitHub events.

**Terminology.** A **mission** is a stateful, bounded goal expressed as a labeled GitHub issue. A **watch** is a stateless repeating loop (same action every tick). A **manager** is just a mission whose job happens to be overseeing other missions — same primitive, different prose. All three run on the same scheduled-executable substrate.

**The model.** Open an issue, apply the `kody:mission` label, write the goal as free prose in the description. On every cron wake the scheduler finds the issue, ticks it, and the tick may spawn other kody runs (`gh workflow run …`) or wait on in-flight child runs. `done: true` in state OR closing the issue stops future work.

- **`mission-scheduler`** — `kind: scheduled` (default cron `*/5 * * * *`, `role: "watch"`). No agent. Preflight is `dispatchMissionTicks`, which lists every open `kody:mission` issue and invokes `mission-tick` once per issue in-process.
- **`mission-tick`** — `kind: oneshot`, one required input `--issue N`. Reads two things: the issue body (the mission, human-owned prose) and a dedicated state comment (JSON, bot-owned, minimized via GraphQL so it's collapsed in the UI). Agent decides the next step using only `gh` + `Read`; it never edits the working tree. At the end of its turn it emits a fenced `kody-mission-next-state` block with `{ cursor, data, done }`, which the postflight persists back to the state comment (with auto-bumped `rev`).

**The state-comment convention.** `src/scripts/issueStateComment.ts` defines the primitive: one comment per marker per issue, body starts with `<!-- <marker> -->` then a `json` fenced block with `{ version: 1, rev, cursor, data, done }`. `loadIssueStateComment` / `writeIssueStateComment` are registered generic pre/postflight scripts parameterized by `with.marker` — any future stateful executable (not just missions) can reuse them.

**Intent vs. state separation.** The issue description is 100% human-owned. Humans edit prose to steer the mission (extend a deadline, widen scope, abort). The bot never touches the description. State lives exclusively in the minimized state comment. Two fields, two owners, no collisions.

**Spawning children.** A tick spawns other kody runs via `gh workflow run kody.yml -f issue_number=<N>`. Works without a PAT because `workflow_dispatch` isn't subject to GitHub's anti-recursion safety on the default `GITHUB_TOKEN` — that's why we prefer it over posting `@kody` comments (which would silently not trigger a child run).

**Trigger routing.** `src/dispatch.ts` routes `schedule` events and empty `workflow_dispatch` to `mission-scheduler`, so consumers add exactly one line (`schedule: - cron:`) to their existing single `kody.yml`. No per-capability workflow files.

**Scale.** Fan-out is sequential in-process (`dispatchMissionTicks` calls `runExecutable("mission-tick", ...)` per issue). Fine for small N; if a consumer ever runs many missions simultaneously, swap to `gh workflow run` dispatch for parallelism. Scheduler itself always exits 0 — individual tick failures surface on the owning issue, not as a cron failure.

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
    orchestrator/ … release/ … watch-stale-prs/ … init/
  scripts/
    {runFlow,fixFlow,fixCiFlow,resolveFlow,reviewFlow}.ts
    {loadConventions,loadCoverageRules,composePrompt}.ts
    {discoverQaContext,frameworkDetectors,loadQaGuide,resolvePreviewUrl}.ts  — ui-review preflights
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

## Version history / split context

- Legacy engine lives at **`aharonyaircohen/Kody-Engine-Lite`** under the package name `@kody-ade/engine`, frozen at v0.7.14. Do not add features there.
- This repo (`aharonyaircohen/kody-engine`, package `@kody-ade/kody-engine`) is a clean split — only the executor + Build executable + scripts survived the move. No `src-v2/`, no `kody-lean`, no 7-stage pipeline history.
- Current version: see `package.json` (started at `0.2.0` because `0.1.x` was taken on npm by a deprecated predecessor). **Patches only** — do not bump minor/major without explicit ask.

## Tester / live-test repo

**`aharonyaircohen/Kody-Engine-Tester`** is the live-test bed. It is a Next.js + Payload CMS LMS with intentional pre-existing quality-gate failures (TypeScript errors, time-sensitive tests, missing Postgres) so verify drafts are informative, not scary.

- Its `.github/workflows/kody.yml` pulls `@kody-ade/kody-engine@latest` via `npx`. Version bumps propagate automatically on next run.
- Its `kody.config.json` declares `agent.model`, quality commands, and `testRequirements` (route.ts files require a sibling `route.test.ts`).
- To live-test a change: publish the new kody version, comment `@kody` on a fresh issue there (or PR comment for fix/fix-ci/resolve).

## How to proceed on a new session

1. Read the relevant code in `src/` — start with `executor.ts` and the profile directories under `src/executables/`.
2. For feature requests: is it an **existing profile** change (tweak one command), a **new profile** (new top-level command — new dir under `src/executables/`), a **script** change (new postflight hook), or an **executor** change (new conditional primitive / new SDK surface)? 90% of the time it's scripts or a profile.
3. `pnpm typecheck && pnpm test && pnpm test:e2e` before any commit.
4. Release flow: bump patch in `package.json`, update version string in `src/entry.ts`, commit, tag `vX.Y.Z`, `git push --follow-tags`, `npm publish --access public`.
5. Live-test on the tester before declaring success.

## External dependencies worth knowing

- **`@anthropic-ai/claude-agent-sdk`** — the Claude Code SDK the executor calls via `runAgent`.
- **LiteLLM** — started by `src/litellm.ts` when the configured model isn't Anthropic-native.
- **`gh` CLI** — the only way kody talks to GitHub. Never use the raw API directly in new scripts.
