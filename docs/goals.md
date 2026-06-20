# Goals

Goals are the company layer's **what**.

A goal names an outcome and owns the manager loop that moves toward that
outcome. It tracks the evidence required to prove the outcome, chooses the next
missing evidence, dispatches the responsible duty or executable, and stops when
the outcome is done or blocked.

A goal may use duties, but it is not a duty. A duty is a standing
responsibility. A goal is a temporary objective.

## Canonical Shape

Goal templates and instances are physically separate:

```text
.kody/goals/templates/<goal-slug>/state.json
.kody/goals/instances/<goal-instance-id>/state.json
```

Templates are reusable definitions. Instances are live runs with facts and
progress. Persisted runtime instances belong on the `kody-state` branch.

Templates may come from `kody-store` or from the consumer repo. Store templates
are shared defaults; consumer templates are repo-specific. Live instances are
consumer-owned runtime state only.

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

The scheduler writes the new instance under `.kody/goals/instances/<id>/state.json`
on the consumer repo's `kody-state` branch, then ticks that instance. Supported
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
  "duties": ["release", "qa-goal", "npm-publish"],
  "route": [
    {
      "stage": "prepare",
      "evidence": "releasePrExists",
      "duty": "release",
      "executable": "release-prepare"
    },
    {
      "stage": "qa",
      "evidence": "qaPassed",
      "duty": "qa-goal",
      "executable": "qa-goal",
      "args": {
        "issue": { "fact": "issue" }
      }
    },
    {
      "stage": "publish",
      "evidence": "packagePublished",
      "duty": "npm-publish",
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
| `duties` | yes | Allowlist of duty slugs this goal may route to. |
| `route` | yes | Ordered routing table. Each evidence item should have one route step. |
| `route[].stage` | yes | Stage name used while the route step is active. |
| `route[].evidence` | yes | Evidence key the route step is responsible for producing. |
| `route[].duty` | yes | Duty responsible for the evidence. Must be listed in `duties`. |
| `route[].executable` | optional | Concrete executable to run. Omit only when the duty profile already selects the executable. |
| `route[].args` | optional | CLI args for the executable. Values may reference earlier facts. |
| `stage` | optional | Current stage. `goal-manager` updates it to the active route step or `done`. |
| `facts` | yes | Observed evidence and runtime values reported by duties. |
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

1. Load `.kody/goals/instances/<id>/state.json`.
2. Read `destination.evidence`.
3. Find the first evidence key that is not `true` in `facts`.
4. If that evidence is already `facts.pendingEvidence`, wait.
5. Find the matching `route` step.
6. Verify the route step's `duty` is attached to the goal.
7. Resolve `route.args`, including `{ "fact": "<name>" }` references.
8. Dispatch the duty or executable for that evidence.
9. Set `facts.pendingEvidence`.
10. When all evidence is true, set `state: "done"`.

Implementation anchors:

- `src/goal/manager.ts`
- `src/scripts/advanceManagedGoal.ts`
- `src/scripts/saveManagedGoalState.ts`
- `tests/unit/goal/manager.test.ts`

## Duty Reports

Duties and executables report observed facts with one stdout line:

```text
KODY_DUTY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true},"facts":{"releasePr":123}}
```

Rules:

- Reports may set evidence truth and factual values under `facts`.
- Reports must not set `destination`, `duties`, `route`, `stage`, `blockers`, or `state`.
- Profiles that emit reports should include `applyDutyReports` in postflight.

## Creating A Managed Goal

Use this checklist:

1. Name the outcome in one sentence.
2. Choose the minimum evidence keys that prove the outcome.
3. Attach only duties that are allowed to advance the goal.
4. Add one route step per evidence key.
5. Prefer existing duties and executables from `kody-store`.
6. Use fact references for values discovered by earlier steps.
7. Start with `state: "active"`, `facts: {}`, and `blockers: []`.
8. Store shared goal templates under `.kody/goals/templates`; store live runtime instances under `.kody/goals/instances` on `kody-state`.

## Legacy Goal Migration

Legacy goal-state files are not a second model. They should be handled in one of two ways:

1. **Stale runtime state**: close or archive it so the scheduler ignores it.
2. **Real active objective**: rewrite it as a managed goal with `destination`, `evidence`, `duties`, `route`, `facts`, and `blockers`.

New goals must use the managed-goal contract and `goal-manager`.

## Do Not

- Do not model a goal as a duty.
- Do not put standing responsibility in `destination.outcome`.
- Do not dispatch arbitrary executables outside the attached `duties` allowlist.
- Do not use a goal for a one-shot task that should be a normal issue job.
