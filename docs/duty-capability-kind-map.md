# Duty Capability Kind Map

## Verdict

Most current duties map cleanly to `observe`, `act`, or `verify`. The important
exceptions are manager loops, engine helpers, chat/ad-hoc helpers, and duties
that currently inspect state and dispatch follow-up work in the same unit.

Use this map as a working classification, not as final schema law.

## Kind Meanings

| Kind | Meaning |
| --- | --- |
| `observe` | Inspect state and return facts, alerts, or suggested next actions. |
| `act` | Change something, create work, or trigger an operation. |
| `verify` | Confirm pass/fail evidence for a specific claim or target. |
| `split` | Current duty mixes kinds and should be split before it becomes a clean capability. |
| `helper` | Engine/internal helper, not a user-facing duty capability. |
| `manager` | Owns progress or routing; belongs above duties. |

## Special Buckets

`split` means the current duty does more than one capability job. Usually it
observes state and then also acts. These should become smaller duties before
`capabilityKind` becomes required.

`helper` means the item supports the engine, tests, scheduler, or dashboard chat.
It is not a normal reusable duty capability for goals/operators to choose.

`manager` means the item decides progress or routing. That is higher than a duty.
Managers may call duties, but should not be modeled as ordinary duties.

## Local Duties

| Duty | New kind | Why |
| --- | --- | --- |
| `live-job-wiring` | `verify` | Confirms live job/staff/tool wiring. |
| `release` | `split` | Current local release duty is a process, not one reusable capability. |

## Store Duties

| Duty | New kind | Why |
| --- | --- | --- |
| `approval-gate` | `verify` | Confirms whether a PR is trusted enough to proceed. |
| `auto-fix-ci` | `split` | Observes failed CI, then dispatches a fix. |
| `auto-resolve` | `split` | Observes conflicts, then dispatches resolution. |
| `auto-sync` | `split` | Observes stale branches, then dispatches sync. |
| `bug` | `act` | Applies a code fix. |
| `ceo-performance-review` | `verify` | Reviews staff performance against evidence. |
| `chore` | `act` | Applies a chore/docs/dependency change. |
| `ci-health` | `verify` | Confirms CI readiness evidence for a PR/goal. |
| `classify` | `helper` | Router/classifier today; could become `observe` only if it stops dispatching. |
| `cleanup` | `observe` | Finds cleanup signals. |
| `code-health` | `observe` | Finds architecture/type-debt signals. |
| `company-graph` | `observe` | Derives orchestration facts. |
| `delivery-graph` | `observe` | Refreshes delivery/CI/PR facts. |
| `design-review` | `verify` | Checks design quality against expectations. |
| `dev-ci-health` | `split` | Observes dev CI and may ensure issue/comment/dispatch. |
| `docs-health` | `observe` | Finds documentation drift and gaps. |
| `documentation-maintenance` | `observe` | Discovers documentation coverage needs. |
| `duty-call` | `observe` | Finds missing duty opportunities. |
| `duty-review` | `verify` | Checks whether a duty is sound and reachable. |
| `duty-scheduler` | `helper` | Engine scheduler helper. |
| `duty-tick` | `helper` | Engine duty-run helper. |
| `duty-tick-scripted` | `helper` | Engine scripted duty-run helper. |
| `feature` | `act` | Implements a feature/refactor. |
| `fix` | `act` | Applies PR feedback. |
| `fix-ci` | `act` | Fixes failing CI. |
| `goal-manager` | `manager` | Chooses next missing evidence and dispatches work. |
| `goal-scheduler` | `helper` | Engine scheduler helper. |
| `health-check` | `observe` | Finds stale Kody-assigned work. |
| `init` | `act` | Installs/scaffolds Kody files. |
| `job-gap-scan` | `observe` | Finds missing duty/capability gaps. |
| `job-live-verify` | `verify` | Confirms live job wiring. |
| `kody-analyzer` | `helper` | Dashboard chat mode, not a normal duty capability. |
| `kody-mem` | `helper` | Dashboard chat mode, not a normal duty capability. |
| `kody-operator` | `helper` | Dashboard chat mode, not a normal duty capability. |
| `kody-vibe` | `helper` | Dashboard chat mode, not a normal duty capability. |
| `memory-compaction` | `observe` | Finds memory compaction opportunities. |
| `merge` | `act` | Merges a PR. |
| `npm-publish` | `act` | Publishes a package version. |
| `plan` | `act` | Creates a plan artifact/comment. |
| `plan-verify` | `verify` | Confirms planned task wiring. |
| `pr-health-triage` | `split` | Reviews PRs and may dispatch repair. |
| `preview-build` | `act` | Builds and publishes a preview. |
| `preview-health` | `split` | Observes previews and may dispatch repairs. |
| `probe-skill` | `verify` | Confirms skill/plugin wiring. |
| `qa` | `verify` | Verifies shipped changelog entries. |
| `qa-engineer` | `split` | Explores/observes, verifies behavior, and may create QA issues. |
| `qa-goal` | `verify` | Verifies QA evidence for a goal. |
| `qa-sweep` | `observe` | Finds live-app QA issues. |
| `qa-verify` | `verify` | Re-checks fixes before merge. |
| `quality-watch` | `observe` | Finds security/coverage/flaky-test signals. |
| `redispatch` | `split` | Observes stalled work and may resume/redispatch it. |
| `release` | `split` | Full release flow; should become goal route or task plan. |
| `release-deploy` | `act` | Deploys or promotes a release. |
| `release-merge` | `act` | Merges a prepared release PR. |
| `release-prepare` | `act` | Creates/prepares a release PR. |
| `release-publish` | `act` | Tags, publishes, and creates a release. |
| `release-state` | `observe` | Observes version, release PR, tag, and package publish state. |
| `repo-graph` | `observe` | Derives repository topology facts. |
| `reproduce` | `act` | Creates a failing reproduction artifact/test. |
| `research` | `observe` | Inspects context and returns findings. |
| `resolve` | `act` | Resolves merge conflicts. |
| `revert` | `act` | Reverts commits. |
| `review` | `verify` | Reviews a PR and returns findings. |
| `skills-research` | `observe` | Finds useful skills and fit. |
| `spec` | `split` | Current shape is an orchestrated research/plan flow. |
| `sync` | `act` | Syncs a PR branch. |
| `system-audit` | `observe` | Finds broken coordination/state. |
| `task-job-fail-once` | `helper` | Test helper for task job retry behavior. |
| `task-job-pass-a` | `helper` | Test helper for task job behavior. |
| `task-job-pass-b` | `helper` | Test helper for task job behavior. |
| `task-jobs` | `helper` | Task/job runner helper, not a capability. |
| `task-leader` | `manager` | Owns/dispatches progress across work. |
| `task-memorize` | `act` | Writes durable task memory. |
| `task-memory-extractor` | `split` | Observes recommendations and writes memory. |
| `task-verifier` | `verify` | Confirms task/backlog quality. |
| `ui-review` | `verify` | Checks UI behavior against PR intent. |
| `vercel-dev-deploy` | `act` | Deploys dev preview. |
| `vercel-production-deploy` | `act` | Deploys production. |
| `verify-deployment-live` | `verify` | Confirms a deployment URL responds as expected. |
| `verify-package-published` | `verify` | Confirms a package version is visible in npm. |
| `verify-release-pr-ready` | `verify` | Confirms a release PR is open, non-draft, and green. |
| `work-briefing` | `observe` | Summarizes current work and decisions. |
| `worker-ask` | `helper` | Ad-hoc staff chat/run helper, not a normal duty capability. |

## Summary By Name

| Bucket | Duties |
| --- | --- |
| `observe` | `cleanup`, `code-health`, `company-graph`, `delivery-graph`, `docs-health`, `documentation-maintenance`, `duty-call`, `health-check`, `job-gap-scan`, `memory-compaction`, `qa-sweep`, `quality-watch`, `release-state`, `repo-graph`, `research`, `skills-research`, `system-audit`, `work-briefing` |
| `act` | `bug`, `chore`, `feature`, `fix`, `fix-ci`, `init`, `merge`, `npm-publish`, `plan`, `preview-build`, `release-deploy`, `release-merge`, `release-prepare`, `release-publish`, `reproduce`, `resolve`, `revert`, `sync`, `task-memorize`, `vercel-dev-deploy`, `vercel-production-deploy` |
| `verify` | `live-job-wiring`, `approval-gate`, `ceo-performance-review`, `ci-health`, `design-review`, `duty-review`, `job-live-verify`, `plan-verify`, `probe-skill`, `qa`, `qa-goal`, `qa-verify`, `review`, `task-verifier`, `ui-review`, `verify-deployment-live`, `verify-package-published`, `verify-release-pr-ready` |
| `split` | `release` (local), `auto-fix-ci`, `auto-resolve`, `auto-sync`, `dev-ci-health`, `pr-health-triage`, `preview-health`, `qa-engineer`, `redispatch`, `release` (store), `spec`, `task-memory-extractor` |
| `helper` | `classify`, `duty-scheduler`, `duty-tick`, `duty-tick-scripted`, `goal-scheduler`, `kody-analyzer`, `kody-mem`, `kody-operator`, `kody-vibe`, `task-job-fail-once`, `task-job-pass-a`, `task-job-pass-b`, `task-jobs`, `worker-ask` |
| `manager` | `goal-manager`, `task-leader` |

## Main Cleanup Targets

Start with these before making `capabilityKind` required:

| Duty | Recommended cleanup |
| --- | --- |
| `release` | Convert to managed goal route or task plan using release-* act duties plus verify steps. |
| `task-leader` | Move progress ownership to goal/task manager; keep only small observe/act/verify capabilities. |
| `auto-fix-ci` | Split into CI observation and explicit fix action. |
| `auto-resolve` | Split into conflict observation and explicit resolve action. |
| `auto-sync` | Split into stale-branch observation and explicit sync action. |
| `dev-ci-health` | Split branch-CI observation from issue/comment/dispatch actions. |
| `pr-health-triage` | Return findings/recommendations first; let goal/task route dispatch repairs. |
| `preview-health` | Split preview observation from repair action. |
| `redispatch` | Split stalled-work detection from resume/dispatch action. |
| `task-memory-extractor` | Split memory recommendation observation from memory write. |
