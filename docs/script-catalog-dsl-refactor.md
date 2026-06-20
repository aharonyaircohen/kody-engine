# Script catalog cleanup + profile DSL refactor

## Goal

Stop `src/scripts/` from being a junk drawer of single-executable orchestration code, by making the `profile.json` DSL expressive enough that custom `xxxFlow.ts` glue files become unnecessary.

**Success criteria:**
1. Every script in `src/scripts/` is referenced by ≥2 executables (mechanically enforced).
2. The 5 PR-branch executables (`fix`, `revert`, `resolve`, `fix-ci`, `init`) all run via a single shared lifecycle, with no per-executable `xxxFlow.ts` file.
3. Managed goals stay in the explicit `goal-manager` scripts; the old goal solo-script cluster is retired instead of abstracted.
4. `src/scripts/index.ts` registers ~35 scripts instead of today's 76.

## Problem (data)

Today (`pnpm test` clean, version 0.4.x):

- 69 distinct scripts referenced across 29 profiles (`src/executables/*/profile.json`).
- **35 are referenced by exactly 1 executable** — violating the invariant in [CLAUDE.md](../CLAUDE.md) that `src/scripts/` is "only cross-cutting utilities used by multiple executables."
- 8 are used by 2 executables.
- 26 are used by 3+ executables (genuine shared utilities).

The 35 solo scripts cluster into recognisable shapes:

| Cluster | Solo scripts | Used by |
| --- | --- | --- |
| PR-branch lifecycle | `fixFlow`, `revertFlow`, `resolveFlow`, `fixCiFlow`, `initFlow` | `fix`, `revert`, `resolve`, `fix-ci`, `init` |
| Managed goal | `loadGoalState`, `advanceManagedGoal`, `saveManagedGoalState`, `commitGoalState` | `goal-manager` |
| Dispatch/classify | `classifyByLabel`, `dispatchClassified`, `recordClassification`, `dispatch`, `dispatchDutyFileTicks` | `classify`, `spec`, `duty-scheduler` |
| Duty tick | `loadJobFromFile`, `parseJobStateFromAgentResult`, `runTickScript` | `duty-tick`, `duty-tick-scripted` |
| Reproduce | `parseReproOutput`, `verifyReproFails` | `reproduce` |
| Run/plan | `requirePlanDeviations`, `resolveArtifacts`, `postPlanComment` | `run`, `plan` |
| Research | `diagMcp`, `postResearchComment` | `research` |
| QA | `createQaGoal`, `discoverQaContext`, `loadQaContext`, `resolveQaUrl`, `warmupMcp` | `qa-engineer`, `ui-review` |
| Misc one-offs | `markFlowSuccess`, `requireFeedbackActions`, `resolvePreviewUrl`, `stageMergeConflicts`, `startFlow` | various |

The naming tell is `xxxFlow` — these are per-executable orchestration scripts pretending to be shared utilities.

## Why this happened

The profile DSL today only offers low-level primitives (run-script-X, then run-script-Y, with optional `runWhen`). When an executable needs orchestration logic that can't be expressed as a flat list of scripts (branching, retries, state-load-fanout), it has two routes:

1. Inline TS inside the executable dir — **forbidden** by invariant 2.
2. Promote a new TS file to `src/scripts/` — **path of least resistance**, formally legal even when the script is single-use.

Everyone takes route 2. The "design smell" check in CLAUDE.md ("never the middle ground — simplify to shell or genuinely cross-cutting") isn't enforced anywhere, so it doesn't bind.

## Non-goals

- **No new top-level abstraction.** The executor + profile contract stays. We're widening the vocabulary of an existing API, not adding a second one.
- **No YAML changes.** Invariant 5 stands. Nothing in `templates/kody.yml` or any `.github/workflows/*.yml` changes.
- **No executor role drift.** `src/executor.ts` must remain role-agnostic — no `if (lifecycle === "pr-branch")` branches in the executor itself. Lifecycle expansion happens in profile-loading, before the executor sees the script list.
- **No retroactive YAML/workflow capability changes.** Capability ships via `npm publish` as today.
- **No test rewrites** beyond what each phase requires for green CI. Test files in `tests/unit/` that pin current behaviour stay until that behaviour changes.

## Design: the `lifecycle` profile key

Today a profile says:

```jsonc
{
  "scripts": {
    "preflight": [
      { "script": "syncFlow" },
      { "script": "setLifecycleLabel", "with": { "label": "kody:fixing", ... } },
      { "script": "fixFlow" },
      { "script": "loadTaskState" },
      { "script": "loadConventions" },
      { "script": "loadPriorArt" },
      { "script": "loadMemoryContext" },
      { "script": "loadCoverageRules" },
      { "script": "composePrompt" }
    ],
    "postflight": [
      { "script": "parseAgentResult" },
      { "script": "verify" },
      { "script": "commitAndPush" },
      { "script": "ensurePr" },
      ...
    ]
  }
}
```

After the refactor it says:

```jsonc
{
  "lifecycle": "pr-branch",
  "lifecycleConfig": {
    "label": { "name": "kody:fixing", "color": "e99695", "description": "kody: applying review feedback" },
    "context": "task",
    "result": "agent-task",
    "branchSource": "feedback-pr"
  },
  "scripts": {
    "preflight": [],
    "postflight": []
  }
}
```

`lifecycle: "pr-branch"` is a macro. At profile-load time (in `src/profile.ts`), it expands to the canonical preflight/postflight chain. Per-executable variation is expressed via `lifecycleConfig` fields (label, context bundle, result parser, branch source).

The executor itself never reads `lifecycle`. By the time the executor receives the profile, it sees an already-expanded `scripts.preflight` and `scripts.postflight`. Invariant 1 (executor stays role-agnostic) is preserved.

### Lifecycle catalog (initial)

| Lifecycle | Replaces | Cluster size |
| --- | --- | --- |
| `pr-branch` | `fixFlow`, `revertFlow`, `resolveFlow`, `fixCiFlow`, `initFlow` | 5 |
| `managed-goal` | `loadGoalState`/`advanceManagedGoal`/`saveManagedGoalState`/`commitGoalState` | 4 |
| `issue-comment` | `postPlanComment`, `postResearchComment` (parameterised by comment shape) | 2 |
| `scheduled-watch` | already exists as `role: "watch"`; promote to first-class lifecycle | n/a |

### Context bundle macro (`lifecycleConfig.context`)

Five preflight scripts are loaded together by every PR-branch executable: `loadTaskState`, `loadConventions`, `loadPriorArt`, `loadMemoryContext`, `loadCoverageRules`. Bundle as `context: "task"`. Other bundles: `context: "goal"` (load goal state), `context: "minimal"` (none).

## Phases

Each phase ships as one or more commits on `main` (per memory: no feature branches in kody repo), each green on `pnpm typecheck && pnpm test && pnpm test:e2e`, and culminates in a version bump + tag + publish.

---

### Phase 1 — Catalog the patterns

**Scope:** no code; documentation only.

Read every solo-use script and assign it to a cluster. Write the cluster table into [AGENTS.md](../AGENTS.md) under a new "Solo-script cleanup" section. For each cluster, record:
- Which executables use it.
- The minimum DSL primitive needed to express it (e.g., `lifecycle: "pr-branch"`, or `context: "task"` bundle).
- Which scripts collapse versus which stay as parameters.

**Deliverables**
- New section in [AGENTS.md](../AGENTS.md) ("Lifecycle catalog").
- This plan file's "Lifecycle catalog (initial)" table replicated and refined there.

**Acceptance**
- Every solo script in the table above has an assigned cluster.
- A reviewer can read [AGENTS.md](../AGENTS.md) and predict, for any future executable, which lifecycle (if any) it should target.

**Risks**
- The exercise reveals a cluster that doesn't fit any pattern. Treat that script as "genuinely solo" and route it to phase 5 (relocate, don't generalise).

---

### Phase 2 — Build `lifecycle: "pr-branch"` end-to-end on one executable

**Scope:** prove the DSL pattern works on the smallest, best-tested member of the biggest cluster — `fix`.

**Code changes**

1. [src/profile.ts](../src/profile.ts) — add `lifecycle` and `lifecycleConfig` fields to the profile schema. Validate at load time. Reject unknown lifecycle names.
2. Add `src/lifecycles/index.ts` and `src/lifecycles/prBranch.ts` exporting a function `expand(profile) → profile` that:
   - Returns the profile unchanged if `profile.lifecycle` is unset.
   - For `lifecycle: "pr-branch"`: prepends the canonical preflight (sync → label → branch-source → context-bundle → composePrompt) and appends the canonical postflight (parseAgentResult → verify → commitAndPush → ensurePr → mirrorStateToPr → postIssueComment) to the profile's existing `preflight`/`postflight` arrays. Profile-supplied scripts run **after** lifecycle preflight and **before** lifecycle postflight so executable-specific steps still slot in.
3. Wire `expand` into `loadProfile` (or wherever profile.json is parsed today) so the executor never sees an unexpanded profile.
4. Migrate `src/executables/fix/profile.json`:
   - Add `lifecycle: "pr-branch"` and `lifecycleConfig` (label + `context: "task"` + `result: "agent-task"` + `branchSource: "feedback-pr"`).
   - Remove every script from `scripts.preflight` / `scripts.postflight` that the lifecycle now provides.
   - Leave behind only the `fix`-specific step (`requireFeedbackActions`).
5. Delete [src/scripts/fixFlow.ts](../src/scripts/fixFlow.ts) and its registration in [src/scripts/index.ts](../src/scripts/index.ts).

**Tests**

- New unit test `tests/unit/lifecycles/prBranch.test.ts` — given a minimal profile with `lifecycle: "pr-branch"`, assert that `expand()` produces the expected script list.
- Existing `tests/unit/dispatch.test.ts` and any test that hits `fix` must stay green. Where they reference `fixFlow` by name, update to assert the **expanded** script list (i.e., the test pins behaviour, not file names).
- Integration smoke: trigger `@kody fix` on the Tester repo and confirm parity with pre-refactor.

**Acceptance**
- `grep -r "fixFlow" src tests` returns no hits.
- `pnpm test` green.
- The number of registered scripts in `src/scripts/index.ts` drops by exactly 1.
- `git diff --stat src/executables/fix/profile.json` shows the profile got smaller (the lifecycle macro replaced ~9 explicit entries).

**Risks**
- The canonical preflight order in `pr-branch` doesn't match one of the other 4 executables (`revert`, `resolve`, `fix-ci`, `init`). Don't worry about it yet — phase 3 will deal with mismatches by either adding `lifecycleConfig` flags or rejecting the executable from this lifecycle. If we discover the mismatches are deep, **stop and rethink before phase 3**.

---

### Phase 3 — Migrate the rest of the `pr-branch` cluster

**Scope:** apply `lifecycle: "pr-branch"` to `revert`, `resolve`, `fix-ci`, `init`.

For each executable:
1. Diff its current `scripts.preflight` / `scripts.postflight` against the canonical chain.
2. Identify the executable-specific bits (e.g. `stageMergeConflicts` for `resolve`, `initFlow` for `init`).
3. Decide whether each bit is:
   - A standard step that should be in the lifecycle (add it, with a `lifecycleConfig` flag to opt in/out per executable).
   - Genuinely executable-specific (leave it in the profile's `scripts.preflight` / `scripts.postflight` — these run inside the lifecycle bookends).
4. Update `profile.json`, delete the old `xxxFlow.ts`, deregister it.

**Special-case notes (predicted, verify in phase 1)**

- `init` is bigger — `initFlow.ts` is 330 lines and likely does workflow-template writing. It may need a separate `lifecycle: "init-bootstrap"` rather than `pr-branch`. If so, build it in phase 3 as a second lifecycle.
- `resolve` has `stageMergeConflicts` — keep as an executable-specific preflight step inside the lifecycle.
- `fix-ci` mirrors `fix` closely — should drop in with little custom logic.

**Deliverables**
- 5 profiles updated (`fix` from phase 2, plus 4 here).
- 5 `xxxFlow.ts` files deleted.
- ~5 fewer registrations in [src/scripts/index.ts](../src/scripts/index.ts).
- One or two new lifecycle modules under `src/lifecycles/` if `init` warrants its own shape.

**Acceptance**
- `pnpm test` green.
- Solo-use script count drops from 35 to ~30.
- Manual trigger of `@kody fix-ci`, `@kody revert`, `@kody resolve` on the Tester repo produces identical artefacts to the pre-refactor baseline.

**Risks**
- Cross-executable parity bugs: e.g., `revertFlow` did something subtly different than `fixFlow` for state mirroring. Mitigate with integration tests per executable before the migration, then re-run after.
- If two executables resist a shared lifecycle, that is a **signal** — either split into two lifecycle names, or accept that one of them stays bespoke and document why in `AGENTS.md`.

---

### Phase 4 — Retired legacy goal chain

**Status:** obsolete after managed goals became canonical.

The old goal chain was removed instead of folded into a lifecycle abstraction. Managed goals now use the explicit `goal-manager` loop:

- `loadGoalState`
- `advanceManagedGoal`
- `saveManagedGoalState`
- `commitGoalState`

Do not reintroduce the retired legacy goal phase/dispatch/finalize scripts for new goal work.

### Phase 5 — Relocate the residual + enforce the invariant

**Scope:** mop up + make the rule mechanical.

After phases 2–4, ~20 solo scripts should remain. These are genuinely executable-specific things that don't fit any lifecycle (e.g., `parseReproOutput`, `resolvePreviewUrl`, `warmupMcp`, `diagMcp`).

**Code changes**

1. Create the layout `src/scripts/shared/` and `src/scripts/executable/<name>/` (or any equivalent split that keeps registration in one place).
2. Move each remaining solo script from `src/scripts/` into `src/scripts/executable/<owning-name>/`. Registration stays in [src/scripts/index.ts](../src/scripts/index.ts) (or a delegating sub-registry) so profile references don't break.
3. Add `scripts/check-script-modularity.ts` (or extend an existing CI check) that:
   - Parses every `src/executables/*/profile.json`.
   - Builds the `script-name → [executables]` map.
   - For every script in `src/scripts/shared/`, asserts `len(executables) ≥ 2`.
   - For every script in `src/scripts/executable/<name>/`, asserts it is referenced only by `<name>`'s profile.
   - Fails with a clear message naming the offending scripts.
4. Wire the check into `pnpm test` and `.github/workflows/ci.yml`.

**Deliverables**
- New directory split.
- New CI check.
- [CLAUDE.md](../CLAUDE.md) invariant 2 rewritten to describe the new layout (`shared/` versus `executable/<name>/`) and the mechanical check.

**Acceptance**
- `pnpm test` runs the modularity check and it passes.
- Manually breaking the rule (registering a single-use script in `shared/`) makes CI fail.
- The script catalog has roughly 35 entries, all genuinely shared.

**Risks**
- The check is wrong (false positives) on first commit. Land it in "warn" mode for one release, flip to "error" in the next.

---

## Sequencing and dependencies

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
 (docs)     (one ex.)    (cluster)   (next       (mop-up +
                                      cluster)    enforce)
```

Strict dependency: phase 2 must ship and bake on `main` for at least one release before phase 3 starts. Reason: the lifecycle expansion lives in profile-loading code paths every executable shares — a regression there breaks everything at once, so we want a small blast radius first.

Phases 3 and 4 are **independent** of each other (different clusters), so if phase 3 is bogged down, phase 4 can proceed.

Phase 5 must come last because the CI check depends on most solo scripts already being gone — landing it earlier would force unrelated cleanup or hide real issues behind warning noise.

## Risks (cross-phase)

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Lifecycle module becomes the new junk drawer | Medium | Cap one lifecycle module at ~150 lines. If `goalChain.ts` balloons, that's the signal the abstraction is wrong, not that the module needs to be bigger. |
| Executor temptation to read `lifecycle` directly | Medium | Code review against invariant 1. Add a comment in `src/executor.ts` saying so. |
| Test churn drowns the refactor | Medium | Tests should pin **behaviour** (final script list, observable outputs), not script names. Refactor tests during phase 2; the pattern carries through phases 3–4. |
| Lifecycle migration changes user-visible behaviour | High | Integration smoke against the Tester repo at the end of each phase. Diff GH artefacts (comments, labels, PR bodies) before/after. |
| Single user (this user) is the only reviewer | High | Use the Tester repo as the source of truth — if its automation breaks, the refactor failed. |

## Rollback

Each phase is one or more commits on `main`. To roll back:
1. `git revert <commits>` (no force-push, per memory).
2. Re-publish previous version (`pnpm publish` after bumping back to the prior version — npm doesn't allow republishing the same version).
3. The consumer's `templates/kody.yml` always installs latest, so a republish covers it.

If a phase ships an irreversible change (none planned, but if e.g. a lifecycle expansion produces subtly different output that downstream PRs already consume), prefer fix-forward over revert.

## Open questions

1. Should `lifecycle` expansion happen in `src/profile.ts` or in a dedicated `src/lifecycles/index.ts`? **Lean: dedicated module**, so the profile loader stays a parser and lifecycle logic is testable in isolation.
2. Does `lifecycleConfig.context` belong as a profile-level field (e.g. `profile.context: "task"`) or nested under `lifecycleConfig`? **Lean: nested**, because context is meaningful only with a lifecycle — exposing it standalone re-creates the "many small primitives" mess this refactor is unwinding.
3. Should the CI check from phase 5 also enforce "no executable-local TS files outside `src/scripts/executable/<name>/`" (i.e., the existing invariant 2)? **Lean: yes**, since the check is already walking the tree.

## Out of scope (future work)

- Generalising hooks/skills/commands the same way (executables ship plugin parts today via `buildSyntheticPlugin`; that mechanism is fine and not part of this refactor).
- Reducing `src/executor.ts` from 896 lines back under the 800-line ceiling. Worth doing, but separate from this refactor — phase 1 of any executor-trim work should confirm none of the lifecycle expansion logic accidentally migrated *into* the executor.
- Re-evaluating the 30-executable count itself. Whether some executables should merge is a separate question — this refactor assumes today's executable set as given.
