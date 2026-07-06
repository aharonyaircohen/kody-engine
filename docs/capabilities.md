# Capabilities

A **Capability** is how the agency can produce a result.

The canonical storage root is:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
```

A capability explains what reusable ability exists, who normally owns it,
when it may run, what kind of result it promises, and which capability
implementation performs the work. Intent owns why the company cares. Goal owns
what outcome should become true. A normal capability should receive input, do
one kind of work, and return structured output or report evidence that another
layer can consume.

```text
input -> capability call -> structured output
```

## Parent Boundary

A capability does not own its parent goal, loop, route, or stage. It should not
need to know which managed goal dispatched it in order to do its work.

The clean flow is:

```text
goal or loop owns parent context
workflow step calls capability with domain inputs
capability returns call-local result facts
parent attaches that result to the goal or loop evidence model
```

Do not make a normal capability require `--goal`, `--loop`, route stage, or
destination outcome as part of its core contract. Those values belong to the
parent model. A capability may receive domain inputs such as `--pr`, `--branch`,
`--url`, `--version`, or `--evidence` when the requested work needs them.

Some older Store capabilities still accept `--goal` or emit a target-bearing
report. Treat that as compatibility plumbing while the engine migrates to
parent-owned result attachment. Do not spread it to new capability contracts.

## Workspace Boundary

The reusable capability does not own workspace. A **capability call** owns
`targetWorkspace`.

```text
targetWorkspace: project
```

means the call may change the consumer project's product, code, or docs.

```text
targetWorkspace: agency
```

means the call may change the consumer agency definitions or state in
`kody-state`.

`delivery` describes how the result is reviewed or persisted:

```text
delivery: pull-request | comment | direct-write
```

Creator capabilities use:

```text
targetWorkspace: agency
delivery: pull-request
```

Project work capabilities normally use:

```text
targetWorkspace: project
delivery: pull-request
```

## Core Rule

Each normal capability should mainly do one type of work:

| Kind | Work | Meaning |
| --- | --- | --- |
| `observe` | inspect | Check current state and return facts, alerts, or suggested next actions. |
| `act` | change | Create, modify, trigger, publish, merge, deploy, or otherwise perform a requested action. |
| `verify` | confirm | Decide whether a specific claim passed or failed, with evidence and blockers. |

These are not three top-level models. The top-level public model is
`Capability`. `capabilityKind` classifies the capability promise and selects the
result shape expected from that capability.

## What Capabilities Are Not

A capability is not a goal or manager loop. A capability may name a workflow
when the public action needs ordered capability steps.

Do not put long-term progress ownership inside a capability. If work needs
multiple steps, put step order in a workflow. If it needs waiting or business
completion decisions, model that above the capability:

| Responsibility | Correct home |
| --- | --- |
| Decide what outcome is complete | Goal |
| Choose next missing evidence | Goal manager |
| Track required issue/PR work and attempts | Task/job/run state |
| Do one reusable inspect/change/confirm ability | Capability |
| Chain reusable abilities for one run | Workflow |
| Structure evidence and write progress audit logs | Goal/loop decision and persistence path |
| Decide the write workspace for one run | Capability call |

The important boundary is:

```text
Loop decides when to wake a target.
Goal decides what is needed.
Capability provides how the agency can produce the result.
Workflow composes capability calls for one run.
Capability call declares targetWorkspace.
Parent model attaches capability output to active goal or loop.
```

Valid chains are intentionally flexible. A loop may wake a capability directly,
wake a workflow directly, or wake a goal. A goal may then route straight to
capabilities or to a workflow-backed capability when that evidence step needs
ordered substeps.

## State Boundary

Capabilities are reusable definitions. They can run many times with new inputs,
but they should not remember long-term business progress.

- `capability`: reusable ability and public contract.
- `capabilityCall`: one run of a capability with concrete inputs, `targetWorkspace`, and `delivery`.
- `goal`: durable outcome state; owns destination evidence, stage, facts, and blockers.
- `agentLoop`: durable cadence state; owns heartbeat/cursor data and the goal, workflow, or capability target it wakes.

A scheduled capability may have an operational ledger for cursors or
deduplication. That ledger is not goal progress. If the system needs to decide
what is complete or which step is next, put that in a goal or agentLoop, not in
the capability.

## Canonical Shape

Capabilities live in project `.kody/capabilities/` or in the company store:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
```

`profile.json` is metadata and routing. `capability.md` is the human-owned
capability contract body.

Example:

```json
{
  "name": "release-prepare",
  "action": "release-prepare",
  "capabilityKind": "act",
  "targetWorkspace": "project",
  "delivery": "pull-request",
  "describe": "Prepare a release pull request."
}
```

## Field Contract

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Capability slug. Must match the folder name. |
| `describe` | yes | Short capability summary. |
| `capabilityKind` | recommended | Capability promise: `observe`, `act`, or `verify`. |
| `action` | optional | Public action name. If absent, defaults to capability name. |
| `workflow` | optional | Ordered capability calls for one run. |
| `agent` | optional | Agent identity, the who. |
| `every` | optional | Scheduler cadence. Use `manual` for on-demand capabilities. |
| `mentions` | optional | GitHub logins to mention in capability output. |
| `capabilityTools` | optional | Locked capability MCP tool names. |
| `targetWorkspace` | optional | Default workspace for direct calls: `project` or `agency`. |
| `delivery` | optional | Default result delivery: `pull-request`, `comment`, or `direct-write`. |
| `disabled` | optional | Prevents scheduled execution. |

## Result Models

`capabilityKind` maps to one validated result model.

### Observe

Observe capabilities inspect state and report what is true.

```ts
interface ObserveResult {
  kind: "observe"
  facts?: Record<string, unknown>
  alerts?: Array<{ level?: "info" | "warning" | "error"; message: string }>
  suggestedActions?: Array<{ action: string; args?: Record<string, unknown>; reason?: string }>
  evidence?: Record<string, unknown>
}
```

Do not dispatch repairs from an Observe capability. Return facts or suggestions;
let a goal, task plan, or operator choose the next Act capability.

### Act

Act capabilities perform a requested change or trigger an operation.

```ts
interface ActResult {
  kind: "act"
  status: "created" | "changed" | "triggered" | "skipped" | "failed"
  changedResources?: ResourceRef[]
  createdResources?: ResourceRef[]
  actionResult?: Record<string, unknown>
  evidence?: Record<string, unknown>
}
```

Act capabilities may report evidence such as `releasePrExists`, `mainMerged`,
or `productionDeployed`, but they do not decide the whole goal is complete.

### Verify

Verify capabilities decide whether a claim passed.

```ts
interface VerifyResult {
  kind: "verify"
  passed: boolean
  evidence?: Record<string, unknown>
  blockers?: string[]
  checkedAt?: string
}
```

Verify capabilities do not fix the thing they checked. If verification fails,
the parent model chooses the next Act capability.

## Capability Call Contract

Workflow steps are capability calls:

```json
{
  "capability": "verify-docs",
  "targetWorkspace": "project",
  "delivery": "comment",
  "inputs": {
    "artifact": "README.md"
  }
}
```

Creator calls target the agency workspace:

```json
{
  "capability": "capability-creator",
  "targetWorkspace": "agency",
  "delivery": "pull-request"
}
```

## Capability Output Contract

Capability implementations should return one machine-readable result when they
finish:

```text
KODY_CAPABILITY_RESULT={"version":1,"status":"pass","summary":"CI is green.","evidence":{"ciGreen":true},"facts":{"pr":123},"artifacts":[],"missingEvidence":[],"blockers":[]}
```

Rules:

- Omit `target` when the invoking parent owns the goal or loop context.
- `target` is accepted for compatibility or explicit cross-parent reporting.
- `status` must be `pass`, `fail`, `blocked`, `changed`, or `noop`.
- `summary` is required and should be short.
- `evidence` is optional boolean proof the parent may map to goal or loop evidence.
- `facts` is machine data for the parent goal or loop.
- `artifacts` is optional links or paths.
- `missingEvidence` names expected evidence still not proven.
- `blockers` names concrete blockers the parent should recover from or stop on.
- A capability result says what happened. The parent model decides what it means.

## Capability Report Contract

Older capabilities may report facts by emitting one stdout line:

```text
KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"release-aguy"},"evidence":{"releasePrExists":true},"facts":{"releasePr":123}}
```

Rules:

- Reports are factual only.
- Reports do not set goal `stage`, `route`, `capabilities`, `destination`, `blockers`, or `state`.
- Goal evidence is stored under goal `facts`.
- New capabilities should prefer neutral `KODY_CAPABILITY_RESULT` output and let
  the invoking parent attach it to the active goal or loop.
- Do not emit both marker types for the same evidence in new code. The engine merges both only for compatibility with existing actions.
- Profiles that emit capability evidence should include `applyCapabilityReports` in post-call persistence.
- `saveReport` writes Dashboard markdown under `reports/<goal-or-loop>/runs/` from the goal/loop decision path, after state persistence succeeds.
- Route args can read reported facts with `{ "fact": "<name>" }`.

Capability output is how a reusable capability hands evidence back to a goal. It
is not a manager loop. A capability may prove `releasePrExists`, `mainMerged`,
or `productionDeployed`; the goal decides whether those facts complete the
agentGoal and writes the goal log.
