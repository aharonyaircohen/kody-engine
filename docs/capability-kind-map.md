# Capability Kind Map

## Verdict

The capability model has exactly three capability kinds:

| Kind | Meaning |
| --- | --- |
| `observe` | Inspect state and return facts, alerts, evidence, or suggested next actions. |
| `act` | Change something, create work, trigger an operation, or report action evidence. |
| `verify` | Confirm pass/fail evidence for a specific claim or target. |

There is no fourth capability kind for helpers, managers, schedulers, or control
flow. Items that do not fit one of the three kinds should either be split into
smaller capabilities or kept as internal capability implementations.

## Store Capabilities By Kind

Current `kody-store` capability profiles all declare one of the three real
kinds.

| Kind | Store capabilities |
| --- | --- |
| `observe` | `cleanup`, `code-health`, `company-graph`, `delivery-graph`, `docs-health`, `documentation-maintenance`, `capability-call`, `health-check`, `job-gap-scan`, `kody-analyzer`, `memory-compaction`, `qa-sweep`, `quality-watch`, `release-state`, `repo-graph`, `research`, `skills-research`, `system-audit`, `work-briefing` |
| `act` | `auto-fix-ci`, `auto-resolve`, `auto-sync`, `bug`, `chore`, `dev-ci-health`, `feature`, `fix`, `fix-ci`, `init`, `kody-mem`, `kody-operator`, `kody-vibe`, `merge`, `npm-publish`, `plan`, `pr-health-triage`, `preview-build`, `preview-health`, `redispatch`, `release-deploy`, `release-merge`, `release-prepare`, `release-publish`, `reproduce`, `resolve`, `revert`, `sync`, `task-leader`, `task-memorize`, `task-memory-extractor`, `vercel-dev-deploy`, `vercel-production-deploy` |
| `verify` | `approval-gate`, `ceo-performance-review`, `ci-health`, `design-review`, `capability-review`, `job-live-verify`, `plan-verify`, `probe-skill`, `qa`, `qa-goal`, `qa-verify`, `review`, `task-verifier`, `ui-review`, `verify-deployment-live`, `verify-package-published`, `verify-release-pr-ready` |

## Internal Implementations

These internal implementation profiles are not public capability actions and
should not declare `action` or `capabilityKind`:

| Implementation | Why it is not a capability |
| --- | --- |
| `capability-scheduler` | Scheduler/helper fan-out, not reusable capability output. |
| `capability-tick` | Internal one-tick runner for capability folders. |
| `capability-tick-scripted` | Internal one-tick runner for scripted capability folders. |
| `goal-manager` | Managed-goal progress runner above capabilities. |
| `goal-scheduler` | Scheduler for active managed goals. |
| `release` | Legacy all-in-one release runner; public release work uses split release capabilities. |
| `task-job-fail-once` | Test fixture. |
| `task-job-pass-a` | Test fixture. |
| `task-job-pass-b` | Test fixture. |
| `task-jobs` | Hidden task-plan runner, not operator capability. |

Do not expose internal implementations as top-level capability actions.

## Release Shape

Release stays split into separate capabilities:

| Evidence | Capability | Kind | Implementation |
| --- | --- | --- | --- |
| release state known | `release-state` | `observe` | `release-state` |
| release PR exists | `release-prepare` | `act` | `release-prepare` |
| release PR merged | `release-merge` | `act` | `release-merge` |
| package published | `release-publish` | `act` | `release-publish` |
| deployment promoted | `release-deploy` | `act` | `release-deploy` |

The goal or task layer decides which evidence is still missing. Each capability
only does one reusable capability and returns structured evidence.
