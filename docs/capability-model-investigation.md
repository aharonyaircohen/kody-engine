# Capability Capability Model Investigation

## Verdict

The proposed Observe / Act / Verify model is a strong simplification if it is
treated as the public capability contract for a capability-like unit, not as a new
orchestration layer.

The model should be considered correct only if it keeps these boundaries:

- Goals decide long-term progress.
- Tasks and jobs record required work and attempts.
- A capability/capability does one kind of work and returns structured output.
- The executor stays generic.
- Existing execution mechanics such as `role: "utility"` or `role: "watch"` do
  not get confused with the new capability kind.

## Question Being Tested

Should Kody simplify capabilities into one reusable capability model with one of three
contract kinds?

```text
Observe = inspect current state
Act     = change something or create work
Verify  = confirm pass/fail evidence
```

This investigation is not asking whether Kody needs goals, tasks, jobs, or runs.
Those remain separate. It asks whether capability/executable authoring becomes simpler
when each reusable capability has one clear promise and one structured output
shape.

## Current Verified Model

The current documented model says:

- Intent = why this agency should care.
- Goal = what outcome should become true.
- AgentLoop = when to check or wake work.
- Agent = who runs.
- Capability = how the agency can produce a result.
- Capability = current storage for a capability contract.
- Executable = current storage for a capability implementation.
- Job = required work on a task.
- Run = one attempt.

The current code already supports this split:

- A job lowers to one selected executable.
- A managed goal reads missing evidence, chooses a route step, dispatches a
  capability/executable, then waits for reported evidence.
- Capability reports can add facts/evidence to goal state, but cannot set goal state,
  route, destination, or completion directly.

That means the proposed simplification aligns with the direction of the system:
capabilities should produce facts, changes, or evidence, while goals and tasks decide
what those results mean.

## Evidence Anchors

This investigation is grounded in these current contracts:

- `docs/jobs-model.md`: defines intent, goal, loop, agent, capability, current
  storage names, job, and run, and states that a job points to one executable.
- `docs/capabilities.md`: defines capabilities as current
  storage for capability contracts: metadata, routing, cadence, and allowed outputs.
- `docs/executables.md`: defines executables as concrete runnable actions and
  documents capability reports.
- `docs/goals.md`: defines managed goals as outcome managers that route missing
  evidence to capabilities/executables.
- `src/job.ts`: lowers jobs into selected executable runs.
- `src/goal/manager.ts`: plans one goal tick from missing evidence and route
  facts.
- `src/scripts/applyCapabilityReports.ts`: applies factual capability reports without
  letting reports own goal structure.
- `src/scripts/planTaskJobs.ts` and `src/scripts/dispatchNextTaskJob.ts`:
  keep multi-step task work in task/job machinery rather than inside one capability.

## Proposed Shape

Add an author-facing capability kind:

```json
{
  "capabilityKind": "observe"
}
```

Allowed values:

```text
observe | act | verify
```

This should be separate from existing execution mechanics:

- `role` answers how the engine executes it: primitive, utility, watch, etc.
- `kind` answers timing: oneshot, scheduled.
- `capabilityKind` answers the user-facing promise: observe, act, verify.

Do not replace `role` with this. A no-agent shell script can be an Act
capability. A scheduled watch can be an Observe capability. A primitive agent can
be Verify.

## Contract Per Kind

### Observe

Purpose:

```text
Inspect state and report what is true.
```

Allowed outputs:

- facts
- alerts
- suggested next actions
- optional evidence values

Should not:

- dispatch follow-up work by itself
- mark goals complete
- create PRs/issues unless explicitly classified as Act instead

Example output:

```json
{
  "kind": "observe",
  "facts": {
    "ciState": "failed",
    "failingWorkflow": "test"
  },
  "alerts": [
    {
      "level": "warning",
      "message": "PR CI is failing on the current head SHA."
    }
  ],
  "suggestedActions": [
    {
      "action": "fix-ci",
      "args": { "pr": 123 }
    }
  ]
}
```

### Act

Purpose:

```text
Change something, create work, or trigger an operation.
```

Allowed outputs:

- changed resources
- created issues/PRs/jobs
- triggered workflow/run IDs
- action result
- optional evidence values

Should not:

- decide that the larger business goal is complete
- silently create follow-up orchestration beyond its requested action
- combine verification unless verification is a small safety check required to
  make the action trustworthy

Example output:

```json
{
  "kind": "act",
  "result": "created",
  "changedResources": [
    { "type": "pr", "number": 456, "url": "https://github.com/owner/repo/pull/456" }
  ],
  "evidence": {
    "releasePrExists": true
  }
}
```

### Verify

Purpose:

```text
Confirm whether a specific claim is true.
```

Allowed outputs:

- passed / failed
- evidence
- blockers
- optional facts discovered while verifying

Should not:

- fix the thing it is verifying
- create a new plan unless asked to return a recommendation
- advance goal state directly

Example output:

```json
{
  "kind": "verify",
  "passed": false,
  "evidence": [
    {
      "source": "preview",
      "message": "Checkout button is missing on mobile."
    }
  ],
  "blockers": [
    "Preview does not satisfy the requested acceptance check."
  ]
}
```

## Catalog Fit Check

The current catalog mostly fits this model.

Clear Observe candidates:

- CI health checks
- PR health triage
- stale work checks
- repo graph refresh
- docs health
- code health
- delivery graph
- work briefing
- system audit

Clear Act candidates:

- run
- feature
- bug
- chore
- fix
- fix-ci
- resolve
- sync
- revert
- merge
- release-prepare
- release-publish
- release-deploy
- npm-publish
- preview-build
- init

Clear Verify candidates:

- review
- ui-review
- qa-verify
- qa-goal when it is checking an approved target
- ci-check when it is asked to prove a specific expected CI state
- deployment verification
- checklist validation

Ambiguous or high-risk candidates:

- `auto-fix-ci`, `auto-resolve`, `auto-sync`: these currently observe and then
  dispatch action. Under the proposed model, either split them into Observe
  plus Act, or classify them as Act with an explicit precondition scan.
- `release`: this is a full process. It should become a goal route or task plan,
  not a single capability capability.
- `task-leader`: this sounds like a manager/orchestrator. It should not be a
  normal capability capability unless reduced to one clear output.
- `goal-manager`: this is intentionally above capabilities. It should not be
  reclassified as Observe, Act, or Verify.
- `capability-scheduler` and `goal-scheduler`: these are engine scheduling helpers,
  not company capabilities.
- `classify`: this is not a clean Observe/Act/Verify fit. It may be a separate
  router/helper, or it can be treated as Observe only if its output is a
  classification fact rather than a dispatch.

## Correctness Tests

The model is correct if these tests pass.

### 1. Single Purpose Test

For every capability/capability, ask:

```text
Does this mainly inspect, change, or confirm?
```

If the answer is "all three", it is not a reusable capability. It is a goal,
task plan, manager loop, or workflow bundle.

### 2. Output Ownership Test

Ask:

```text
Who consumes the output?
```

Correct:

- Goal consumes evidence.
- Task consumes job result.
- Operator consumes report.
- Another explicitly routed step consumes facts.

Wrong:

- Capability writes long-term progress directly.
- Capability mutates goal route/state/destination.
- Capability decides the whole business outcome is done.

### 3. Replay Test

Ask:

```text
If this runs twice, is the repeated effect safe and understandable?
```

Observe should be naturally repeatable.

Verify should be repeatable and may produce a different verdict if reality
changed.

Act must be idempotent or explicitly protect against duplicate PRs/issues/tags.

### 4. Composition Test

Ask:

```text
Can a goal or task plan compose this with another capability without knowing its
internal steps?
```

If yes, the boundary is good.

If the caller must know internal private state, hidden phases, or special
side-effects, the capability is too large.

### 5. UI Test

Ask:

```text
Would a dashboard operator understand this capability from kind + name + output?
```

Good examples:

- Observe: "Check CI health"
- Act: "Create release PR"
- Verify: "Verify preview"

Bad examples:

- "Manage release"
- "Handle PRs"
- "Run company process"

Those names hide multiple concerns.

## Main Risk

The biggest risk is moving orchestration out of "capability" in name only, then hiding
it inside Observe or Act implementations.

The most likely failure shape:

```text
Observe scans state -> decides next step -> dispatches fix -> marks evidence
```

That is not Observe. That is a manager loop. It should be split:

```text
Observe scans state -> returns facts/suggestions
Goal/task/manager chooses next step
Act performs chosen change
Verify confirms result
```

## Recommended Model

Use this as the durable mental model:

```text
Goal       = decides what needs to become true
Task       = holds concrete work on an issue or PR
Job        = one required unit of work
Capability = reusable unit that observes, acts, or verifies
Run        = one attempt
```

In the current repo, `Capability` can be implemented by the existing
capability/profile/executable system. The user-facing model can simplify before the
internal folders fully converge.

## Recommended Migration

### Phase 1: Add classification only

Add optional `capabilityKind` to profiles or capability profiles:

```text
observe | act | verify
```

No runtime behavior change.

Validation:

- allow only the three values
- warn when missing
- do not require immediately for old catalog items

### Phase 2: Add structured output contracts

Introduce output contracts for each capability kind.

Start with capability reports and task outputs:

- Observe can emit facts, alerts, suggested actions.
- Act can emit changed resources and result.
- Verify can emit pass/fail evidence and blockers.

Do not let these outputs mutate goal completion directly. Goal manager still
decides.

### Phase 3: Classify the catalog

Create a catalog report that lists every capability/executable and one of:

```text
observe
act
verify
manager/helper/process-bundle
```

The last group is the important cleanup list.

### Phase 4: Split the process-bundles

Start with the worst offenders:

- release
- task-leader
- auto-fix-ci
- auto-resolve
- auto-sync

For each, decide:

- Is this a goal route?
- Is this a task plan?
- Is this an Observe capability plus an Act capability?
- Is this just an engine helper?

### Phase 5: Enforce the boundary

Add tests that reject confusing combinations once migration is far enough along.

Possible enforcement:

- Observe profiles cannot include dispatch scripts unless explicitly exempt.
- Verify profiles cannot include commit/publish/merge scripts.
- Act profiles must declare idempotency or duplicate protection.
- Goal reports cannot write `state`, `route`, `destination`, or `capabilities`.

## Proof Work Before Committing To The Model

Do these before making the field required:

1. Generate a full catalog classification table from `kody-store`.
2. Mark every ambiguous item and explain why.
3. Pick one real flow, preferably release, and remodel it as:

```text
Observe -> Act -> Verify
```

4. Confirm the remodeled flow does not need capability-owned progress state.
5. Confirm the dashboard can present the new model more simply.
6. Add tests for profile parsing, output validation, and goal report safety.
7. Run a live test in the tester repo using one Observe, one Act, and one Verify
   capability inside a managed goal route.

## Decision

Adopt the model if the release and PR-repair flows can be expressed without a
single capability owning the whole process.

Reject or revise it if too many real capabilities require this shape:

```text
inspect -> decide -> act -> verify -> update long-term progress
```

That shape is not a capability. It is a manager loop, and Kody already has a better
home for that: goals, tasks, and jobs.
