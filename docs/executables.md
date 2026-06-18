# Executables

How the engine is composed out of single-purpose commands, and how
`goal-tick` — the only deterministic flow with no agent — fits in.

The split between **executable** (how) and **duty** (why/when) and
**staff** (who) is defined in [`docs/jobs-model.md`](jobs-model.md).
This file is the shape reference for the **how**: a directory, a
declarative JSON profile, and an optional agent prompt. Code-level
shape is [`src/executables/types.ts`](../src/executables/types.ts).

## Directory contract

Every executable lives at `src/executables/<name>/` and contains only:

| File / dir | Required | Purpose |
| --- | --- | --- |
| `profile.json` | yes | Declarative shape: inputs, Claude Code config, `cliTools`, preflight/postflight script list |
| `prompt.md` | when an agent runs | The agent's instructions; loaded by `composePrompt` |
| `*.sh` | optional | Mechanical side-effect work (git, fs, tool installs). Colocated so one command = one directory |
| `skills/<name>/`, `commands/<name>.md`, `agents/<name>.md`, `hooks/<name>.json` | optional | Claude Agent SDK plugin parts specific to this one executable. `buildSyntheticPlugin` resolves them from the executable dir first, then falls back to `src/plugins/` |
| `types.ts` | (top-level only) | The shared `Profile` / `ScriptEntry` / `Context` contract — NOT a per-executable thing |

Executable shell scripts read secrets from environment variables only. Kody
runtime/dashboard/pool code owns decrypting `.kody/secrets.enc` and forwarding
values; individual executables must not read the vault file directly.

**No TypeScript inside executable directories.** Logic that has to be
TypeScript and is shared across multiple executables lives in
[`src/scripts/`](../src/scripts/) and is registered in
[`src/scripts/index.ts`](../src/scripts/index.ts). Logic that has to be
TypeScript and is specific to one executable is a design smell — either
simplify it so shell can express it, or promote it to a real
cross-cutting utility. The middle ground is what bloated the old flow
scripts and is explicitly banned (see `AGENTS.md` invariant 2).

Adding a new command = drop a new `src/executables/<name>/` dir with
its profile + prompt + any `.sh` scripts; register any new *shared* TS
scripts in `src/scripts/index.ts`. Issue-triggered commands need no
dispatch edits — [`src/dispatch.ts`](../src/dispatch.ts) picks the
right one from the GHA event payload (PR/issue comment + body match).

## Role and kind

Every profile declares a `role` (what it IS) and a `kind` (when it
runs). The two are orthogonal. The executor uses both to decide how to
run a profile and how to route from it.

### `role`

| Role | Agent? | What it does |
| --- | --- | --- |
| `primitive` | yes | Single-step agent executor: flow → agent → verify → commit → PR. Most commands (`run`, `fix`, `fix-ci`, `resolve`, `revert`, `review`, `ui-review`, `plan`, `spec`, `research`, `classify`, `reproduce`, `feature`, `bug`, `chore`, `sync`, `merge`, `qa-engineer`, `worker-ask`) |
| `orchestrator` | no | Drives primitives via a postflight transition table (comment-based; one GHA run per step). e.g. `classify` |
| `container` | no | Runs declared `children` sequentially in-process (one GHA run for the whole flow). Routing is per-child `next` maps over action types — no `@kody` comments dispatched |
| `watch` | no | Scheduled observer that inspects repo state and may trigger other executables. `kind: "scheduled"` is the typical pairing. `duty-scheduler`, `goal-scheduler` |
| `utility` | no | One-off administrative work. `init`, `release`, `release-prepare`, `release-publish`, `release-deploy`, `plan-verify`, `probe-skill`, `job-live-verify` |

### `kind`

| Kind | When it fires |
| --- | --- |
| `oneshot` (default) | On demand — a comment, a manual dispatch, or a watch's tick |
| `scheduled` | On a `schedule` cron (typically a GHA `schedule:` block). Watch executables use this; the cron lives on the profile so the watch is self-describing |

Watches that emit their own PR (e.g. `release-prepare`) must check
`commitResult.pushed === true` before calling `gh pr create` — not just
`hasCommitsAhead`. The shared `commitAndPush` postflight returns the
push outcome explicitly so callers don't silently open a PR for a
no-op tick.

## Script composition

Preflight and postflight lists are arrays of `ScriptEntry`. Each entry
is **either** a registered TS function from `src/scripts/index.ts` (via
`script: "name"`) **or** a shell script colocated with the executable
(via `shell: "name.sh"`). A `runWhen` map is the only conditional
primitive — keys are dotted paths into the context
(`args.mode`, `data.goal.phase`, …) and the script runs only when every
key matches.

```json
{
  "scripts": {
    "preflight": [
      { "script": "loadGoalState" },
      { "script": "handleAbandonedGoal", "runWhen": { "data.goal.state": "abandoned" } },
      { "script": "deriveGoalPhase",     "runWhen": { "data.goal.state": "active" } }
    ],
    "postflight": [
      { "script": "commitGoalState" }
    ]
  }
}
```

The executor never references role-specific concepts — no `run` /
`fix` / `review` strings, no executable-name branching. It just loads
the profile, validates inputs, runs the declared scripts, and
(optionally) calls the agent.

## Catalog

One line each, grouped by function. The full surface is
`src/executables/`.

**Issue → code (agent, end-to-end)**

| Name | What it does |
| --- | --- |
| `run` | Branch, code, commit, open PR. The primary authoring path |
| `feature` / `bug` / `chore` | Sub-orchestrators dispatched by `classify` (feature work, reproduce-then-fix, docs/dep-bump) |
| `reproduce` | Write a failing test only — leaves it failing; the next run makes it pass |

**Issue triage & planning (read-only or short)**

| Name | What it does |
| --- | --- |
| `classify` | Routes an `@kody` issue comment to `feature` / `bug` / `chore` / `spec` |
| `plan` | Read-only plan; artifact flows into `run` via `resolveArtifacts` |
| `research` | Read-only context map; supports delta mode against a prior research comment |
| `spec` | No-agent sub-orchestrator for spec/RFC issues (research → plan, then stop) |

**PR operations**

| Name | What it does |
| --- | --- |
| `fix` | Apply review feedback to a PR. Default for bare `@kody` on a PR comment |
| `fix-ci` | Fix failing CI on a PR. `--run-id` pins a specific run |
| `resolve` | Merge default branch into the PR; agent resolves conflicts |
| `sync` | The clean-merge happy path of `resolve`, exposed separately. Never invokes the agent |
| `merge` | Squash-merge a release PR (mechanical, no agent) |
| `revert` | `git revert` one or more commits on a PR. Fully mechanical |
| `review` | Read-only structured diff review; verdict drives `fix`'s next action |
| `ui-review` | Same as `review` but drives the preview deployment with the Playwright CLI |
| `qa-engineer` | Free-form QA; opens findings as goals |
| `worker-ask` | Ad-hoc one-shot: run a worker persona against an inline message |

**Watch substrate (scheduled, scheduler runs no agent)**

| Name | Role | What it does |
| --- | --- | --- |
| `duty-scheduler` | `watch` / `scheduled` (`*/5 * * * *`) | Ticks every `.kody/duties/<slug>/` folder via `duty-tick` |
| `goal-scheduler` | `watch` / `scheduled` (`*/5 * * * *`) | Ticks every `.kody/goals/<id>/state.json` via `goal-tick` |

**Release stages (no agent, deterministic)**

| Name | What it does |
| --- | --- |
| `release` | Single `--mode prepare` or `--mode finalize`; routes to the two below |
| `release-prepare` | Bump version, regenerate `CHANGELOG.md`, open the release PR |
| `release-publish` | Tag the merged commit, `prepublishOnly` + `npm publish`, create the GH release |
| `release-deploy` | Run `deployCommand` + `notifyCommand` after publish |
| `npm-publish` | Publish the current `package.json` version to npm using `NPM_TOKEN`; no agent |

**Bootstrap & live-test**

| Name | What it does |
| --- | --- |
| `init` | Scaffold a consumer repo (`kody.config.json` + workflow). No agent |
| `job-live-verify` | Live-test: validates that a job's wiring resolves through dispatch |
| `plan-verify` | Live-test: validates plugin/skill/hook wiring end-to-end |
| `probe-skill` | Live-test: validates executable-local skill resolution |
| `preview-build` | Run a preview build via the bundled templates |

## `goal-tick` — the deterministic flow

`goal-tick` is the only executable that runs a non-trivial chain with
**no agent**. It advances a `.kody/goals/<id>/state.json` state
machine once per scheduler tick. The previous 596-line bash
`tick.sh` was retired in favor of a typed preflight chain + a small
pure phase machine, so every step's name appears in the executor log
and failures are attributed by script.

### Inputs

- `--goal <id>` — directory name under `.kody/goals/`. Required, no
  slashes or `..` (path-traversal guard).

### Preflight chain

The chain is ordered. Each step is gated on `runWhen` (context dotted
paths) so only the relevant scripts run for a given tick.

| # | Script | `runWhen` | Role |
| --- | --- | --- | --- |
| 1 | `loadGoalState` | always | Reads `state.json` from the `kody-state` branch into `ctx.data.goal`. On a missing or malformed file, sets `ctx.skipAgent` and the next tick retries |
| 2 | `handleAbandonedGoal` | `data.goal.state === "abandoned"` | Closes every open child task issue and every open stacked PR, transitions `state → "closed"` |
| 3 | `deriveGoalPhase` | `data.goal.state === "active"` | Lists child task issues + their PRs and classifies the tick's `phase` via the pure `derivePhase` function in `src/goal/phase.ts` |
| 4 | `finalizeGoal` | `data.goal.phase === "all-done"` | Prepares the **leaf** PR as the single deliverable (retarget to default branch, promote to ready, close intermediate stacked PRs and intermediate task issues, leave the leaf and its task issue OPEN) and transitions `state → "done"`. The engine never auto-merges |
| 5 | `dispatchNextTask` | `data.goal.phase === "ready-to-dispatch"` | Fires `gh workflow run kody.yml -f executable=classify -f issue_number=<n> -f base=<leaf-or-default>` for the next open task without an open PR, then records it in `ctx.data.goal.lastDispatchedIssue` |
| 6 | `saveGoalState` | always | Computes the persisted form of `ctx.data.goal` (with `extra` round-trip preserved) and stashes it for the postflight writer. Always sets `ctx.skipAgent = true` (no agent for goal-tick) |
| 7 | `skipAgent` | always | Redundant guard — the chain never reaches an agent |

### Postflight

| Script | Role |
| --- | --- |
| `commitGoalState` | Writes the stashed state to the `kody-state` branch via the Contents API. Skips the write entirely on a no-op tick (state byte-identical) so idle ticks don't generate `chore(goals): …` commits |

### The `src/goal/` module

Split out so the phase logic is testable in isolation and the gh
operations surface is uniform across scripts:

| File | Responsibility |
| --- | --- |
| `state.ts` | `GoalState` type, permissive parser, on-disk I/O, `nowIso`. Preserves unknown JSON fields on round-trip so dashboard-written fields (title, description) aren't stomped |
| `stateStore.ts` | `fetchGoalState` / `putGoalState` — read/write the state file on the `kody-state` branch via the Contents API |
| `phase.ts` | Pure `derivePhase(snapshot) → GoalPhase` state machine and `pickNextDispatchable(snapshot)`. No I/O; 100% branch coverage in unit tests |
| `labels.ts` | Single source of truth for goal-flow labels: `goalLabel(id)` → `goal:<id>`, plus the `kody:qa-gate` constant that marks a non-task verification issue |
| `operations.ts` | gh-CLI wrappers returning `OperationResult<T>` (no thrown errors). The shared scripts in `src/scripts/` decide what to do on failure; surfaces the actual gh stderr instead of swallowing it with `2>/dev/null \|\| echo ""` (the old pattern that hid multi-hour stalls in production goals) |

### Phase machine

`GoalPhase` is one of:

| Phase | Meaning |
| --- | --- |
| `missing` | `state.json` not on the `kody-state` branch — no-op |
| `terminal` | `state` is `closed` or `done` — no-op |
| `abandoned` | `state === "abandoned"` — `handleAbandonedGoal` runs, then `state → "closed"` |
| `awaiting-merge` | DEPRECATED. Legacy `state` value retained for parse compatibility; the engine no longer writes it (no auto-merge). A parked goal stays inert until an operator flips `state` back to `active` |
| `idle` | Active, but nothing to do (no tasks, or every task done while a `kody:qa-gate` issue is still OPEN — the gate blocks `all-done` until the goal-manager worker verifies and closes it) |
| `in-flight` | Active, the leaf task PR is still draft (kody is working) — wait |
| `ready-to-dispatch` | Active, at least one open task has no open PR — `dispatchNextTask` runs |
| `all-done` | Active, every open task has a ready (non-draft) PR or is closed — `finalizeGoal` runs |

`derivePhase` is a pure function over `{ lifecycleState, childTasks }`
and is the ONE script in the chain that decides what the next action
should be. Everything else is gated on the result.

### Stacked-PR model

Goal-tick's per-task model is **stacked PRs**, not sequential merges:

- Each new task PR forks from the **previous task's head ref**
  (cached on `ctx.data.goal.leafPr` by `deriveGoalPhase`), so the
  cumulative diff is visible on the leaf PR.
- Intermediate PRs stay open throughout the goal. They only close
  transiently when the goal finalizes (cascade close on the leaf).
- The engine does NOT squash-merge. Auto-merge to the default branch
  was removed by product decision — a goal finishes with one open,
  review-ready PR and a human merges it in GitHub.
- `dispatchNextTask` uses `workflow_dispatch`, not an
  `@kody <verb>` comment, for two reasons: (a) bot-authored `@kody`
  comments are silently dropped (see [`docs/duty-dispatch.md`](duty-dispatch.md));
  (b) `workflow_dispatch` starts a fresh run in its own GHA job,
  keeping the scheduler tick fast and well below the cron timeout.

### State persistence

State lives on a dedicated `kody-state` branch (not the working tree
and not the default branch) so goal ticks don't pollute the
consumer's main history with `chore(goals): …` commits. The first
`commitGoalState` after a real change is the only one that writes;
idle ticks are byte-identical and the postflight skips the write
entirely.

## Adding a new executable

1. Create `src/executables/<name>/`.
2. Write `profile.json` (see [`src/executables/types.ts`](../src/executables/types.ts) for the shape). Pick a `role` and a `kind`.
3. Write `prompt.md` if an agent runs in this executable.
4. Add any `.sh` scripts for mechanical work.
5. Register any new **shared** TypeScript logic in
   `src/scripts/<name>.ts` and `src/scripts/index.ts`. Do NOT put
   executable-specific TypeScript inside the executable directory.
6. If the new executable is **issue- or PR-triggered**, no dispatch
   edits are needed — `src/dispatch.ts`'s PR switch handles it. If
   it is **scheduled**, add a `schedule` cron to the profile and a
   per-feature workflow on consumer repos. If it is **dispatched by
   name from a comment** (e.g. `qa-engineer`), add a `\b<name>\b`
   case to the PR switch — ordered by specificity, since names
   overlap via word boundaries (e.g. `ui-review` vs `review`).

Issue-triggered commands need no dispatch edits. The PR switch in
`src/dispatch.ts` does — and there is no generic fallthrough there.
