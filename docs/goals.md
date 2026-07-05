# Goals

Goals are the company layer's **what**.

A goal names an outcome and owns the manager loop that moves toward that
outcome. It tracks the evidence required to prove the outcome, chooses the next
missing evidence, dispatches the responsible capability or executable, and stops when
the outcome is done or blocked.

A goal may use capabilities, but it is not a capability. A capability is a standing
capability. A goal is a temporary agentGoal.

Goals are the normal home for long-term progress routing. Capabilities stay reusable
capabilities: `observe`, `act`, or `verify`. A goal may compose many capabilities,
but a capability should not secretly become the goal's manager loop.

A goal can route directly to capabilities. It can also route to a public
capability backed by a workflow when one evidence step needs ordered capability
steps. Use the workflow for step order; keep progress, evidence, retries,
issues, and blockers on the goal.

A goal may know which capability it is dispatching. A normal capability should
not need to know which goal instance dispatched it. The goal runner owns the
parent context and attaches capability results to goal evidence.

## Canonical Shape

Goal templates and instances are physically separate:

```text
.kody/goals/templates/<goal-slug>/state.json
<statePath>/goals/instances/<goal-instance-id>/state.json
```

Templates are reusable definitions. Instances are live runs with facts and
progress. Persisted runtime instances belong in the configured state repo, not
the consumer repo.

Templates may come from `kody-store` or a repo-specific source. Store templates
are shared defaults. Live instances are consumer-owned runtime state only.

Store goals are inactive by default. A consumer repo activates shared goals in
`kody.config.json`:

```json
{
  "company": {
    "activeGoals": ["web-release"]
  }
}
```

Scheduled activation creates a fresh instance from the template every time bucket:

```json
{
  "company": {
    "activeGoals": [
      { "template": "web-release", "every": "1w", "facts": { "issue": 123 } }
    ]
  }
}
```

The scheduler writes the new instance under `<statePath>/goals/instances/<id>/state.json`
in `stateRepo`, then ticks that instance. Supported
intervals are `Nm`, `Nh`, `Nd`, and `Nw`.

After activation, the consumer runtime instance should become `state: "active"`
and include required repo facts such as `facts.issue`.

Required managed-goal shape:

```json
{
  "version": 1,
  "state": "active",
  "type": "release",
  "destination": {
    "outcome": "Version 1.2.3 is published and verified.",
    "evidence": ["releasePrExists", "qaPassed", "packagePublished"]
  },
  "capabilities": ["release", "qa-goal", "npm-publish"],
  "route": [
    {
      "stage": "prepare",
      "evidence": "releasePrExists",
      "capability": "release",
      "executable": "release-prepare"
    },
    {
      "stage": "qa",
      "evidence": "qaPassed",
      "capability": "qa-goal",
      "executable": "qa-goal",
      "args": {
        "issue": { "fact": "issue" }
      }
    },
    {
      "stage": "publish",
      "evidence": "packagePublished",
      "capability": "npm-publish",
      "executable": "npm-publish"
    }
  ],
  "stage": "prepare",
  "facts": {},
  "blockers": []
}
```

## Field Contract

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Managed-goal schema version. Start with `1`. |
| `state` | yes | Lifecycle state. Managed goals normally start as `active`; `goal-manager` writes `done` when complete. |
| `type` | yes | Goal category, such as `release`, `qa`, or `migration`. |
| `destination.outcome` | yes | Human-readable finish line. This is the goal's what. |
| `destination.evidence` | yes | Ordered evidence names. The goal is done only when every listed key is true in `facts`. |
| `capabilities` | yes | Allowlist of capability slugs this goal may route to. |
| `route` | yes | Ordered routing table. Each evidence item should have one route step. |
| `route[].stage` | yes | Stage name used while the route step is active. |
| `route[].evidence` | yes | Evidence key the route step is responsible for producing. |
| `route[].capability` | yes | Capability responsible for the evidence. Must be listed in `capabilities`. |
| `route[].executable` | optional | Concrete executable to run. Omit only when the capability profile already selects the executable. |
| `route[].args` | optional | CLI args for the executable. Values may reference earlier facts. |
| `stage` | optional | Current stage. `goal-manager` updates it to the active route step or `done`. |
| `facts` | yes | Observed evidence and runtime values reported by capabilities. |
| `blockers` | yes | Reasons the manager loop cannot safely dispatch the next step. |

Route args may reference earlier facts:

```json
{
  "pr": { "fact": "releasePr" }
}
```

If the referenced fact is missing or not a scalar value, `goal-manager` blocks
instead of dispatching bad input.

## Manager Loop

`goal-scheduler` wakes active managed-goal files and routes them to `goal-manager`. Unmanaged legacy state files are skipped until they are closed or rewritten in the managed shape.

`goal-manager` is deterministic and no-agent:

1. Load `<statePath>/goals/instances/<id>/state.json`.
2. Read `destination.evidence`.
3. Find the first evidence key that is not `true` in `facts`.
4. Find the matching `route` step, even when that evidence is already `facts.pendingEvidence`.
5. Verify the route step's `capability` is attached to the goal.
6. Resolve `route.args`, including `{ "fact": "<name>" }` references.
7. Dispatch or retry the capability or executable for that evidence.
8. Set or keep `facts.pendingEvidence`.
9. When all evidence is true, set `state: "done"`.

`facts.pendingEvidence` is the current missing evidence being pursued. It does
not suppress retries; the responsible route step should be idempotent and should
either report the evidence or a clear blocker.

Route args should pass domain inputs needed for the work, not the parent goal id
or route state. Passing `--goal` into a capability is compatibility behavior for
older Store actions; the clean model is for `goal-manager` to attach neutral
capability output to the current goal.

The route step should name evidence a capability can produce, not a private phase
inside the capability. For example, a web release route composes separate Act capabilities:

| Evidence | Capability | Meaning |
| --- | --- | --- |
| `releasePrExists` | `release-prepare` | Create or reuse the release PR. |
| `mainMerged` | `release-merge` | Merge the prepared PR after checks pass. |
| `productionDeployed` | `vercel-production-deploy` | Deploy main to production and report the URL. |

Do not replace that with one `release` capability that owns prepare, merge, deploy,
and completion internally.

Implementation anchors:

- `src/goal/manager.ts`
- `src/scripts/advanceManagedGoal.ts`
- `src/scripts/saveManagedGoalState.ts`
- `tests/unit/goal/manager.test.ts`

## Capability Evidence

Capabilities and executables return structured evidence for the goal to apply:

```text
KODY_CAPABILITY_RESULT={"version":1,"status":"pass","summary":"Release PR exists.","evidence":{"releasePrExists":true},"facts":{"releasePr":123},"artifacts":[],"missingEvidence":[],"blockers":[]}
```

Older actions may still report observed facts with this compatibility line:

```text
KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true},"facts":{"releasePr":123}}
```

Rules:

- Reports may set evidence truth and factual values under `facts`.
- Reports must not set `destination`, `capabilities`, `route`, `stage`, `blockers`, or `state`.
- New capabilities should use neutral `KODY_CAPABILITY_RESULT` output; the goal
  runner should attach it to the active goal.
- Target-bearing output and `--goal` inputs are compatibility paths, not the
  preferred architecture for new capabilities.
- Do not emit both marker types for the same evidence in new code. Existing mixed output is merged before the goal writes its log.
- Profiles that emit capability evidence should include `applyCapabilityReports` in postflight.
- `saveReport` writes Dashboard markdown under `reports/<goal-or-loop>/runs/` from the goal/loop decision path, after state persistence succeeds.

## Creating A Managed Goal

Use this checklist:

1. Name the outcome in one sentence.
2. Choose the minimum evidence keys that prove the outcome.
3. Attach only capabilities that are allowed to advance the goal.
4. Add one route step per evidence key.
5. Prefer existing capabilities and executables from `kody-store`.
6. Use fact references for values discovered by earlier steps.
7. Start with `state: "active"`, `facts: {}`, and `blockers: []`.
8. Store shared goal templates in `kody-store`; store live runtime instances under `<statePath>/goals/instances` in `stateRepo`.

## Legacy Goal Migration

Legacy goal-state files are not a second model. They should be handled in one of two ways:

1. **Stale runtime state**: close or archive it so the scheduler ignores it.
2. **Real active agentGoal**: rewrite it as a managed goal with `destination`, `evidence`, `capabilities`, `route`, `facts`, and `blockers`.

New goals must use the managed-goal contract and `goal-manager`.

## Do Not

- Do not model a goal as a capability.
- Do not put standing capability in `destination.outcome`.
- Do not require a normal capability to know its parent goal.
- Do not dispatch arbitrary executables outside the attached `capabilities` allowlist.
- Do not use a goal for a one-shot task that should be a normal issue job.
