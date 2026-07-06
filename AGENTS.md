# Response Rule

Do the work first, then answer with a clear headline and the simplest advice for how to proceed.
Think more than you say: do the deeper analysis, then surface only the verdict, key reasons, and next step.

# kody-engine Agent Guide

## What This Is

`@kody-ade/kody-engine` is **kody**: an autonomous development engine. One `@kody`
comment on a GitHub issue/PR runs Claude Code in CI, implements work, commits,
and opens or updates a PR.

The engine has two layers only:

1. **Generic runner**: the engine loads a profile,
   validates args/tools, runs preflight scripts, optionally runs the agent, then
   runs postflight scripts. It knows no product behavior.
2. **Capability profiles**: shared capabilities and agents live in `kody-store`
   under `.kody/`. Profiles declare inputs, tools, Claude Code features, CLI
   contracts, scripts, and optional `runWhen` gates. `prompt.md` sits beside a
   profile when an agent runs.

The consumer workflow stays small: `.github/workflows/kody.yml` triggers on
`@kody` or `workflow_dispatch` and runs
`npx @kody-ade/kody-engine@latest kody-engine ci`.

## Goal/Capability Boundary

Keep parent ownership out of reusable capabilities.

- A goal or loop owns durable progress, destination evidence, route, stage, and
  the decision about what is done.
- A capability owns one reusable action: observe, act, or verify.
- The goal/loop runner owns the current parent id and attaches capability output
  to that parent.
- A normal capability should not require `--goal`, parent route data, stage, or
  destination outcome as part of its contract.
- Existing `--goal` inputs and target-bearing capability reports are
  compatibility paths only. Do not spread that pattern to new capabilities.

## Rule Sources

- `CLAUDE.md` / `AGENTS.md`: hard constraints and conventions: architecture
  invariants, naming, dispatch safety, tests, release rules, forbidden actions.
- [docs/engine-company.md](docs/engine-company.md): operating model for the
  repo-local company layer that maintains this engine.
- `.kody/context/*.md`: background only: company mission, vocabulary, strategy,
  product notes, decisions. Do not rely on it for hard rules unless the current
  capability call explicitly loads it.

## Vocabulary

Canonical model: [docs/jobs-model.md](docs/jobs-model.md). If another doc uses
different terms, treat it as stale.

| Term | Meaning |
| --- | --- |
| `agent` | Who runs: reusable identity in project/store `.kody/agents/<slug>.md`. |
| `capability` | Reusable ability in `.kody/capabilities/<slug>/` with `profile.json` metadata and `capability.md` prose. |
| `capability call` | One concrete run of a capability with inputs, `targetWorkspace`, and `delivery`. |
| `workflow` | Ordered capability calls for one run. |
| `task` | One GitHub issue/PR plus jobs, artifacts, recent history, rolled-up state. |
| `job` | Required work on a task; points to one capability call and records runs. |
| `run` | One execution attempt for a job. Retries add runs under the same job. |
| `goal` | Related task list/state under `.kody/goals/<id>/state.json`; `goal-tick` advances stacked PRs. |
| `loop` | Wake rule for a goal, workflow, or capability. |
| `manager` | Legacy prose label for progress ownership. Do not model it as a capability. |
| `mission` | Dead term. Do not use it. |

Naming note: consumer-facing paths and prompt tokens use **capability/agent**:
`.kody/capabilities/<slug>/`, `capability-scheduler`, `capability-tick`,
`{{capabilityReference}}`, `{{capabilitySlug}}`, `{{agentSlug}}`,
`{{capabilitySchedule}}`. Older `job` identifiers remain only
where renaming would break public contracts: `Job` in [src/job.ts](src/job.ts),
`kody-job-next-state`, `loadJobFromFile`, and `writeJobStateFile`.
The `deadVocabulary` guard bans retired scheduler/tick dispatch identifiers, but
not the broad `job` token.

## Capability Calls

Commands are capability calls. Public commands are discovered from project
`.kody/capabilities/`, the configured company store, then minimal engine
built-ins. The shared command catalog lives in `kody-store`.

| Command | Input | Agent | Trigger / purpose |
| --- | --- | --- | --- |
| `run` | `--issue` | yes | Default issue authoring path: branch, code, commit, PR. |
| `fix` | `--pr` | yes | Bare `@kody` on PR; applies review feedback. |
| `fix-ci` | `--pr`, optional `--run-id` | yes | Fix latest or pinned failing CI on PR. |
| `resolve` | `--pr`, optional `--prefer` | yes if conflicts | Merge base into PR and resolve conflicts. |
| `sync` | `--pr` | no | Clean merge-base update + push. |
| `revert` | `--pr`, `--shas` | no | Mechanical `git revert` on PR branch. |
| `merge` | `--pr` | no | Self-gating squash merge; refuses unless PR is CLEAN. |
| `preview-build` | `--pr` | no | Per-PR preview build from config/manual dispatch. |
| `release` | `--issue`, bump/dry-run/prefer flags | no | Legacy all-in-one release path; public release work should use split capabilities below. |
| `release-prepare` | bump/dry-run/prefer/issue | no | Version bump, changelog, release PR. |
| `release-publish` | dry-run/issue | no | Tag, publish, GitHub release. |
| `release-deploy` | dry-run/issue | no | Deploy and notify after publish. |
| `init` | optional `--force` | no | Scaffold consumer config/workflow. |
| `agent-ask` | `--agent` | yes | Dashboard `@agent` one-shot. |
| `qa-goal` | `--issue` | no | Operator-approved QA report -> goal/tasks. |
| `capability-scheduler` | optional `--capability` | no | Internal cron/helper fan-out to due capability folders. |
| `capability-tick` | `--capability`, optional `--force` | yes | Internal one-tick runner for a capability. |
| `capability-tick-scripted` | `--capability`, optional `--force` | no | Internal runner for capability `tickScript`. |
| `goal-scheduler` | none | no | Internal cron fan-out to active goals. |
| `goal-tick` | `--goal` | no | Deterministic stacked-PR goal tick. |
| `task-jobs` | `--issue` | no | Internal runner for next planned capability call in hidden task plan. |
| `plan-verify` | `--issue` | yes | Live-test plugin/skill/hook wiring. |
| `probe-skill` | `--issue` | yes | Live-test local skill resolution. |
| `job-live-verify` | none | yes | Live-test job/agent/locked-tool wiring. |

Long-running CLI-only servers are hardcoded in [src/entry.ts](src/entry.ts), not
the capability registry: `serve`, `pool-serve`, `runner-serve`, `brain-serve`,
`brain-proxy`, `mcp-http-server`. They are not reachable via `@kody <verb>`.

## Command Notes

- `run`: preflight `runFlow -> loadTaskState -> resolveArtifacts ->
  loadConventions -> loadCoverageRules -> composePrompt`; postflight
  `parseAgentResult -> requirePlanDeviations -> verify/checkCoverage ->
  commitAndPush -> ensurePr -> postIssueComment -> writeAgentRunSummary ->
  saveTaskState -> mirrorStateToPr -> advanceFlow`.
- `fix`: extracts feedback from PR comments unless `--feedback` is passed;
  `requireFeedbackActions` ensures something actionable was addressed.
- `fix-ci`: uses failing CI logs; `--run-id` pins the run, otherwise latest
  failing run on PR head SHA.
- `resolve`: clean merge skips agent; conflicts invoke agent, then
  `stageMergeConflicts`, commit, push, PR/comment/state chain.
- `sync`: no-agent clean path of `resolve`.
- `release`: deterministic, no agent. Stages are also invokable directly.
- `init`: idempotent scaffold for `kody.config.json`, `kody.yml`, and scheduled
  capability workflows; `--force` overwrites.

## Capability Runtime

Capability folders:

```text
.kody/capabilities/<slug>/
  profile.json   # every, agent, action, workflow, tools, tickScript, mentions, disabled, stage
  capability.md        # human-owned intent/prose
```

- `capability-scheduler` runs every `*/5 * * * *`, lists capability folders, gates by
  `every`, and invokes `capability-tick` or `capability-tick-scripted` in-process.
- `capability-tick` loads capability + agent + state (`loadJobFromFile`), composes prompt,
  lets the agent act via `gh`/`Read` or locked capability tools, then persists
  `kody-job-next-state` via `writeJobStateFile`.
- `capability-tick-scripted` runs the capability `tickScript`, parses next state from
  stdout, and persists it. Use for deterministic capabilities.
- `mentions` becomes a ready `@login` string exposed as `{{mentions}}`.
- `tools` enables locked-toolbox mode: only `mcp__kody-capability__<tool>` plus
  `submit_state`; no Bash/Read shell access.
- The capability MCP palette currently exposes high-level intents such as
  `list_prs_to_repair`, `sync_pr`, `fix_ci_pr`, `resolve_pr`,
  `recommend_to_operator`, and `read_ledger`.
- Capability state is sidecar state, not a GitHub issue comment. The body is
  human-owned; the bot only advances state.

Dispatch rule: bot-authored `@kody <verb>` comments are banned because bot
comments are filtered to prevent self-dispatch loops. Capabilities must dispatch
by `gh workflow run kody.yml -f capability=<name> -f issue_number=<n>` or by
the in-process capability chain helper. See
[docs/capability-dispatch.md](docs/capability-dispatch.md).

## Repo Map

```text
src/
  executor.ts, profile.ts, tools.ts, dispatch.ts, agent.ts, litellm.ts
  kody-cli.ts, entry.ts, gha.ts
  branch.ts, commit.ts, pr.ts, verify.ts, issue.ts, coverage.ts, prompt.ts, format.ts, config.ts
  capabilities/<name>/{profile.json,capability.md,prompt.md,*.sh,skills/,commands/,agents/,hooks/}
  scripts/*.ts      # shared pre/postflight catalog + registry
  lifecycles/*.ts   # profile lifecycle expanders
bin/kody.ts
docs/
tests/{unit,int,e2e}
```

## Key Invariants

1. **Runner is generic.** The generic runner must not mention role-specific
   concepts (`run`, `fix`, `review`, `issue`, `pr`). It only knows profile,
   scripts, context, SDK call.
2. **Capability dirs contain no TypeScript.** Allowed: `profile.json`,
   `prompt.md`, `*.sh`, and optional plugin parts (`skills/`, `commands/`,
   `agents/`, `hooks/`). Shared TS belongs in `src/scripts/`; capability-specific
   TS is a design smell unless promoted to real shared utility.
3. **Scripts compose.** Each script does one deterministic thing. `runWhen`
   dotted-path equality is the only conditional primitive.
4. **Wrapper logic lives in scripts.** No extra wrapper layer between runner
   and agent; `verify`, `commitAndPush`, `ensurePr`, `postIssueComment`, etc.
   are scripts.
5. **Workflow YAML stays minimal.** New capability ships via npm/profile/script,
   not consumer YAML churn.
6. **Shared scripts stay generic.** No branching on `profile.name`; treat it as
   an opaque label. Per-capability behavior belongs in profile-declared
   scripts/shell. Enforced by [tests/unit/sharedScriptsInvariants.test.ts](tests/unit/sharedScriptsInvariants.test.ts).
7. **Shared scripts do not import capability implementations.** `src/scripts/*.ts`
   may import only the shared type contract.
8. **`.kody/` write allowlist.** Agents may write only allowed subtrees in
   [src/commit.ts](src/commit.ts), currently `.kody/memory/` and `.kody/tasks/`.
   Other `.kody/*` writes are blocked during `run`/`fix`/`resolve`. Watches that
open PRs must require `commitResult.pushed === true`, not only
`hasCommitsAhead`.
9. **Capability scripts read secrets from env only.** Repo vault secrets
(`.kody/secrets.enc`) are decrypted by Kody runtime/dashboard/pool code and
loaded into environment variables before capability calls run. Colocated
shell scripts must not read or decrypt `.kody/secrets.enc` directly.

## Kody Clean Boundary

Hard constraints:

- **Engine**: runs the requested capability call and reports success/failure.
- **Preview capability/tool**: owns preview behavior and preview-provider details.
- **Task-leader/release policy**: decides whether a preview result is required
  for a given PR type.
- **`.github/workflows/kody.yml`**: immutable launcher only; never change this
  file.

## Adding / Changing Capability Implementations

1. Create `.kody/capabilities/<name>/` in `kody-store` for shared commands, or
   in a consumer repo for repo-local commands. Add built-ins to the engine only
   for the minimal bootstrap/runtime surface.
2. Add `profile.json`; pick `role` and `kind`; see
   [docs/capability-implementations.md](docs/capability-implementations.md).
3. Add `prompt.md` if an agent runs.
4. Add `.sh` for colocated mechanical work.
   If it needs a secret, read the expected env var only; do not access the
   vault file directly.
5. Register new shared TS in `src/scripts/<name>.ts` and `src/scripts/index.ts`.
6. Issue-triggered commands need no dispatch edits. PR-comment verbs do need an
   ordered PR switch case in [src/dispatch.ts](src/dispatch.ts) when names
   overlap (`ui-review` before `review`).
7. If adding a solo script, add it to `KNOWN_SOLO_SCRIPTS` in
   [tests/unit/sharedScriptsInvariants.test.ts](tests/unit/sharedScriptsInvariants.test.ts)
   with owner and reason. Remove it if it later becomes shared.

## Lifecycle Catalog

Status: documentation/refactor target; details in
[docs/script-catalog-dsl-refactor.md](docs/script-catalog-dsl-refactor.md).

| Shape | Members | Keep / migrate notes |
| --- | --- | --- |
| `pr-branch` | migrated: `fix`, `fix-ci`, `run`; deferred: `resolve`, `revert` | Lifecycle knobs: `label`, `context`, `contextExtras`, `sync`, `verify`, `advance`, `mirrorState`, `finalize`. `resolve` is merge-only and skips verify; `revert` is no-agent/mechanical. Future no-agent PR flows should use a separate `pr-mechanical`, not widen `pr-branch`. |
| `flow-state` | `spec`, `bug`, `feature`, `chore` | Shared shape: `finishFlow`, `persistFlowState`, `loadIssueContext`, `setLifecycleLabel`, `skipAgent`. `startFlow`/`dispatch` in `spec` may collapse into lifecycle. |
| `goal-chain` | `goal-tick` | Deferred. Its `runWhen` state machine is the lifecycle: `loadGoalState`, `handleAbandonedGoal`, `deriveGoalPhase`, `finalizeGoal`, `dispatchNextTask`, `saveGoalState`, `commitGoalState`. Moving it would just rebadge `goalFlow.ts`. |
| `release-stage` | `release`, `release-prepare`, `release-deploy`, `release-publish` | Shares `notifyTerminal`, `setCommentTarget`, `recordOutcome`, `skipAgent`, `advanceFlow`. [docs/release-merge-refactor.md](docs/release-merge-refactor.md) may collapse this first. |
| `init-bootstrap` | `init` | No lifecycle likely; one-shot bootstrap. Treat as residual / possible script relocation. |
| `dispatch` | `classify`, `capability-scheduler`, partly `spec` | Too few/divergent for abstraction; residual. |
| residual | `reproduce`, `qa-engineer`/`ui-review`, `research`, `plan`, capability tick variants | Examples: `parseReproOutput`, `verifyReproFails`, `resolvePreviewUrl`, `resolveQaUrl`, `discoverQaContext`, `loadQaContext`, `warmupMcp`, `createQaGoal`, `diagMcp`, `postResearchComment`, `postPlanComment`, `loadJobFromFile`, `runTickScript`. |

Mechanical enforcement counts lifecycle-expanded references and checks: no false
positive solo allowlist entries, no unaccounted solo scripts, no stale entries.

## Version / Release Context

- Legacy engine: `aharonyaircohen/Kody-Engine-Lite`, package `@kody-ade/engine`,
  frozen at v0.7.14. Do not add features there.
- Current repo: `aharonyaircohen/kody-engine`, package
  `@kody-ade/kody-engine`; clean split, no `src-v2/`, no `kody-lean`, no
  7-stage pipeline history.
- Current version: `package.json`. Patch bumps only unless explicitly asked.
- Release flow for manual work: bump patch, commit, tag `vX.Y.Z`,
  `git push --follow-tags`, `npm publish --access public`. Consumers use
  `@latest`; [src/entry.ts](src/entry.ts) reads version from `package.json`.

## Tester / Live Testing

Live-test repo: `aharonyaircohen/Kody-Engine-Tester`. It is a Next.js + Payload
CMS LMS with intentional pre-existing quality-gate failures, so verify drafts
are informative rather than scary.

- Its workflow pins an exact `@kody-ade/kody-engine@X.Y.Z`; version bumps do
  not propagate automatically. Resync the tester workflow/template when needed.
- Its `kody.config.json` declares agent model, quality commands, and
  `testRequirements` (`route.ts` requires sibling `route.test.ts`).
- To live-test: publish, then comment `@kody` on a fresh issue there, or on a PR
  for `fix` / `fix-ci` / `resolve`.

## Working Discipline

1. Deep analysis first: read code, trace invariants, understand why the current
   shape exists.
2. Test changes with meaningful unit/int/e2e coverage. Keep
   `pnpm typecheck && pnpm test && pnpm test:e2e` green.
3. A release is not done until tested end-to-end on `Kody-Engine-Tester`.

## New Session Checklist

1. Read relevant `src/` code and the relevant store/project `.kody/capabilities/<name>/` profile.
2. Classify the request: existing profile tweak, new profile, script change, or
   runner change. Most work is profiles/scripts.
3. Run `pnpm typecheck && pnpm test && pnpm test:e2e` before commit.
4. Live-test after publish before declaring success.

## External Dependencies

- `@anthropic-ai/claude-agent-sdk`: Claude Code SDK used by `runAgent`.
- LiteLLM: started by [src/litellm.ts](src/litellm.ts) for non-Anthropic-native
  models.
- `gh` CLI: the only GitHub interface for new scripts. Do not use raw API
  directly in new scripts.
