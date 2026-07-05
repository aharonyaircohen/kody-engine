# Capabilities And Legacy Capabilities

A **Capability** is how the agency can produce a result.

The canonical storage root is now `.kody/capabilities/<slug>/` with
`profile.json` and `capability.md`.

The legacy storage name for a capability contract is **Capability**.
The legacy storage name for a capability implementation is **Executable**.
Both remain readable as compatibility fallbacks while repos migrate.

A capability explains what reusable capability exists, who normally
owns it, when it may run, what kind of result it promises, and which executable
implements it. Intent owns why the company cares. Goal owns what outcome should
become true. A normal capability should receive input, do one kind of work, and
return structured output or report evidence that another layer can consume.

```text
input -> run -> structured output
```

## Parent Boundary

A capability does not own its parent goal, loop, route, or stage. It should not
need to know which managed goal dispatched it in order to do its work.

The clean flow is:

```text
goal/loop runner owns parent context
runner dispatches capability with domain inputs
capability returns run-local result facts
runner attaches that result to the goal/loop evidence model
```

Do not make a normal capability require `--goal`, `--loop`, route stage, or
destination outcome as part of its core contract. Those values belong to the
orchestration layer. A capability may receive domain inputs such as `--pr`,
`--branch`, `--url`, `--version`, or `--evidence` when the requested work needs
them.

Some older Store capabilities still accept `--goal` or emit a target-bearing
report. Treat that as compatibility plumbing while the engine migrates to
parent-owned result attachment. Do not spread it to new capability contracts.

## Core Rule

Each normal capability should mainly do one type of work:

| Kind | Work | Meaning |
| --- | --- | --- |
| `observe` | inspect | Check current state and return facts, alerts, or suggested next actions. |
| `act` | change | Create, modify, trigger, publish, merge, deploy, or otherwise perform a requested action. |
| `verify` | confirm | Decide whether a specific claim passed or failed, with evidence and blockers. |

These are not three top-level models. The top-level public model is
`Capability`. `capabilityKind` classifies the capability's capability
promise and selects the result shape expected from that capability.

## What Capabilities Are Not

A capability is not a goal or manager loop. A capability may name a workflow
when the public action needs ordered capability steps.

Do not put long-term progress ownership inside a capability. If work needs multiple
steps, put step order in a workflow. If it needs waiting or business completion
decisions, model that above the capability:

| Capability | Correct home |
| --- | --- |
| Decide what outcome is complete | Goal |
| Choose next missing evidence | Goal manager |
| Track required issue/PR work and attempts | Task/job/run state |
| Do one reusable inspect/change/confirm capability | Capability contract plus executable implementation |
| Chain reusable capabilities for one run | Workflow on the public capability |
| Structure evidence and write progress audit logs | Goal/loop decision and persistence path |

The important boundary is:

```text
Loop decides when to wake a target.
Goal decides what is needed.
Capability provides how the agency can produce the result.
Workflow composes capabilities for one run.
Runner attaches capability output to the active goal or loop.
Legacy Capability stores old capability contracts.
Legacy Executable stores old concrete implementations.
```

Valid chains are intentionally flexible. A loop may wake a capability directly,
wake a workflow directly, or wake a goal. A goal may then route straight to
capabilities or to a workflow-backed capability when that evidence step needs
ordered substeps.

## State Boundary

Executables and capabilities are reusable definitions. They can run many times with new inputs, but they should not remember long-term business progress.

- `executable`: concrete execution; emits output or reports for this run.
- `capability`: capability contract; explains what kind of capability exists, who owns it, when it may run, and which action or ordered action list implements it.
- `goal`: durable outcome state; owns destination evidence, stage, facts, and blockers.
- `agentLoop`: durable cadence state; owns heartbeat/cursor data and the goal, workflow, or capability target it wakes.

A scheduled capability may have an operational ledger for cursors or deduplication. That ledger is not goal progress. If the system needs to decide what is complete or which step is next, put that in a goal or agentLoop, not in the capability.

## Canonical Shape

Capabilities live in project `.kody/capabilities/` or in the company store:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
```

Legacy Capabilities live in project `.kody/capabilities/`
or in the company store:

```text
.kody/capabilities/<slug>/
  profile.json
  capability.md
```

`profile.json` is metadata and routing. `capability.md` is the
human-owned capability contract body.

Example:

```json
{
  "name": "release-prepare",
  "action": "release-prepare",
  "executable": "release-prepare",
  "capabilityKind": "act",
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
| `executable` | usually | Implementation executable for this capability. |
| `executables` | optional | Ordered executable list for split task work. Use sparingly. |
| `workflow` | optional | Ordered capability steps for one engine run. |
| `agent` | optional | Agent identity, the who. |
| `every` | optional | Scheduler cadence. Use `manual` for on-demand capabilities. |
| `mentions` | optional | GitHub logins to mention in capability output. |
| `capabilityTools` | optional | Locked capability MCP tool names. |
| `disabled` | optional | Prevents scheduled execution. |

`role` and `kind` still belong to executable execution mechanics:

| Field | Answers |
| --- | --- |
| `role` | What kind of executable runtime shape is this? |
| `kind` | Is the executable oneshot or scheduled? |
| `capabilityKind` | What capability promise does this capability make? |

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

Use for:

- checking PR health
- checking CI status
- finding stale work
- detecting blockers

Do not dispatch repairs from an Observe capability. Return facts or suggestions; let
a goal, task plan, or operator choose the next Act capability.

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

Use for:

- creating a PR
- applying a fix
- opening an issue
- merging a PR
- publishing or deploying

Act capabilities may report evidence such as `releasePrExists`, `mainMerged`, or
`productionDeployed`, but they do not decide the whole goal is complete.

### Verify

Verify capabilities confirm whether a specific claim is true.

```ts
interface VerifyResult {
  kind: "verify"
  passed: boolean
  evidence?: Array<{ source?: string; message: string; url?: string }>
  blockers?: string[]
  facts?: Record<string, unknown>
}
```

Use for:

- QA verification
- review verification
- deployment verification
- checklist validation

Do not fix the thing from a Verify capability. If verification fails, return evidence
and blockers so another layer can choose the next Act capability.

## Capability Results

Capabilities return one standard machine result:

```text
KODY_CAPABILITY_RESULT={"version":1,"status":"pass","summary":"CI is green.","evidence":{"ciGreen":true},"facts":{"pr":123},"artifacts":[],"missingEvidence":[],"blockers":[]}
```

Rules:

- Omit `target` when the parent runner already knows the current goal or loop.
- `target` is accepted only for compatibility or explicit cross-parent reporting.
- `status` must be `pass`, `fail`, `blocked`, `changed`, or `noop`.
- `summary` is required and should be short.
- `evidence` is optional boolean proof the parent may map to goal/loop evidence.
- `facts` is machine data for the parent goal or loop to consume.
- `artifacts` is optional links or paths.
- `missingEvidence` names expected evidence still not proven.
- `blockers` names concrete blockers the parent should recover from or stop on.
- The capability result says what happened; the parent decides progress and output.

## Capability Reports

Some current executables report goal evidence through stdout instead of a full
capability result object. This path remains for compatibility:

```text
KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"web-release"},"evidence":{"releasePrExists":true},"facts":{"releasePr":338}}
```

Rules:

- Reports are compatibility output for older actions that cannot yet rely on the
  parent runner attaching neutral results.
- Reports are factual.
- Reports may set evidence and facts.
- Reports must not set `state`, `stage`, `route`, `capabilities`, `destination`, or `blockers`.
- New capabilities should prefer neutral `KODY_CAPABILITY_RESULT` output and let
  the parent runner attach it to the active goal or loop.
- Do not emit both marker types for the same evidence in new code. The engine merges both only for compatibility with existing actions.
- Profiles that emit reports should include `applyCapabilityReports` in postflight so the goal can apply the evidence.
- `saveReport` writes Dashboard markdown under `reports/<goal-or-loop>/runs/` from the goal/loop decision path, after state persistence succeeds.

## Composition Example

A web release should stay a goal route, not one giant release capability:

| Goal evidence | Capability | Kind | Executable |
| --- | --- | --- | --- |
| `releasePrExists` | `release-prepare` | `act` | `release-prepare` |
| `mainMerged` | `release-merge` | `act` | `release-merge` |
| `productionDeployed` | `vercel-production-deploy` | `act` | `vercel-production-deploy` |

The goal decides the next missing evidence. Each capability performs one reusable
capability and reports evidence. GitHub may close the release issue through
normal PR auto-close syntax, but the goal still owns release progress.

## Creating A Capability Contract

Use this checklist:

1. Ask whether the capability already exists.
2. Name the capability contract by the public action it provides.
3. Choose exactly one `capabilityKind`: `observe`, `act`, or `verify`.
4. Put the concrete work in an executable.
5. Add `agent` only when a specific agent matters.
6. Add `every` only when the capability is scheduled.
7. Write `capability.md` with purpose, inputs, outputs, allowed actions, and restrictions.
8. Emit `KODY_CAPABILITY_RESULT` with status, summary, facts, artifacts, missing evidence, blockers, and evidence when relevant.
9. Let the goal or loop apply that evidence, decide the next step, and write the progress log.

## Do Not

- Do not create a capability contract for a one-off issue comment.
- Do not put concrete implementation logic in `capability.md`.
- Do not hide observe plus act plus verify inside one prompt; make it an explicit workflow.
- Do not let a capability own long-term progress or decide business completion.
- Do not make a normal capability require its parent goal id, loop id, route, stage, or destination.
- Do not let capabilities dispatch by bot-authored `@kody` comments; use workflow dispatch or in-process dispatch.
- Do not duplicate an existing store capability without a project-specific reason.
