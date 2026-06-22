# Duties

Duties are reusable capability contracts.

A duty explains why a capability exists, who normally owns it, when it may run,
and which executable implements it. A duty should not own a full process. It
should receive input, do one kind of work, and return structured output or duty
report evidence that another layer can consume.

```text
input -> run -> structured output
```

## Core Rule

Each normal duty should mainly do one type of work:

| Kind | Work | Meaning |
| --- | --- | --- |
| `observe` | inspect | Check current state and return facts, alerts, or suggested next actions. |
| `act` | change | Create, modify, trigger, publish, merge, deploy, or otherwise perform a requested action. |
| `verify` | confirm | Decide whether a specific claim passed or failed, with evidence and blockers. |

These are not three top-level models. The top-level model remains `Duty`.
`capabilityKind` classifies the duty's capability promise and selects the result
shape expected from that capability.

## What Duties Are Not

A duty is not a goal, manager loop, or hidden workflow.

Do not put long-term progress ownership inside a duty. If work needs multiple
steps, routing, waiting, or business completion decisions, model that above the
duty:

| Responsibility | Correct home |
| --- | --- |
| Decide what outcome is complete | Goal |
| Choose next missing evidence | Goal manager |
| Track required issue/PR work and attempts | Task/job/run state |
| Do one reusable inspect/change/confirm action | Duty plus executable |
| Persist factual evidence back to a goal | Duty report via `applyDutyReports` |

The important boundary is:

```text
Goal decides what is needed.
Duty provides one reusable capability.
Executable performs the concrete work.
```

## Canonical Shape

Duties live in project `.kody/duties/` or in the company store:

```text
.kody/duties/<slug>/
  profile.json
  duty.md
```

`profile.json` is metadata and routing. `duty.md` is human-owned intent.

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
| `name` | yes | Duty slug. Must match the folder name. |
| `describe` | yes | Short responsibility summary. |
| `capabilityKind` | recommended | Capability promise: `observe`, `act`, or `verify`. |
| `action` | optional | Public action name. If absent, defaults to duty name. |
| `executable` | usually | Implementation executable, the concrete how. |
| `executables` | optional | Ordered executable list for split task work. Use sparingly. |
| `agent` | optional | Agent identity, the who. |
| `every` | optional | Scheduler cadence. Use `manual` for on-demand duties. |
| `mentions` | optional | GitHub logins to mention in duty output. |
| `dutyTools` | optional | Locked duty MCP tool names. |
| `disabled` | optional | Prevents scheduled execution. |

`role` and `kind` still belong to executable execution mechanics:

| Field | Answers |
| --- | --- |
| `role` | What kind of executable runtime shape is this? |
| `kind` | Is the executable oneshot or scheduled? |
| `capabilityKind` | What capability promise does this duty make? |

## Result Models

`capabilityKind` maps to one validated result model.

### Observe

Observe duties inspect state and report what is true.

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

Do not dispatch repairs from an Observe duty. Return facts or suggestions; let
a goal, task plan, or operator choose the next Act duty.

### Act

Act duties perform a requested change or trigger an operation.

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

Act duties may report evidence such as `releasePrExists`, `mainMerged`, or
`productionDeployed`, but they do not decide the whole goal is complete.

### Verify

Verify duties confirm whether a specific claim is true.

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

Do not fix the thing from a Verify duty. If verification fails, return evidence
and blockers so another layer can choose the next Act duty.

## Duty Results

Duties return one standard machine result:

```text
KODY_DUTY_RESULT={"version":1,"status":"pass","summary":"CI is green.","facts":{"pr":123},"artifacts":[]}
```

Rules:

- `status` must be `pass`, `fail`, `blocked`, `changed`, or `noop`.
- `summary` is required and should be short.
- `facts` is machine data for the parent objective or routine.
- `artifacts` is optional links or paths.
- The duty result says what happened; the parent decides progress and output.

## Duty Reports

Many current executables report goal evidence through stdout instead of a full
capability result object:

```text
KODY_DUTY_REPORT={"target":{"type":"goal","id":"web-release"},"evidence":{"releasePrExists":true},"facts":{"releasePr":338}}
```

Rules:

- Reports are factual.
- Reports may set evidence and facts.
- Reports must not set `state`, `stage`, `route`, `duties`, `destination`, or `blockers`.
- Profiles that emit reports should include `applyDutyReports` in postflight.

## Composition Example

A web release should stay a goal route, not one giant release duty:

| Goal evidence | Duty | Kind | Executable |
| --- | --- | --- | --- |
| `releasePrExists` | `release-prepare` | `act` | `release-prepare` |
| `mainMerged` | `release-merge` | `act` | `release-merge` |
| `productionDeployed` | `vercel-production-deploy` | `act` | `vercel-production-deploy` |

The goal decides the next missing evidence. Each duty performs one reusable
capability and reports evidence. GitHub may close the release issue through
normal PR auto-close syntax, but the goal still owns release progress.

## Creating A Duty

Use this checklist:

1. Ask whether the capability already exists.
2. Name the duty by the one capability it provides, not the whole process.
3. Choose exactly one `capabilityKind`: `observe`, `act`, or `verify`.
4. Put the concrete work in an executable.
5. Add `agent` only when a specific agent matters.
6. Add `every` only when the duty is scheduled.
7. Write `duty.md` with purpose, inputs, outputs, allowed actions, and restrictions.
8. Emit `KODY_DUTY_RESULT` with the duty outcome.
9. If the duty serves a current managed goal, also emit factual `KODY_DUTY_REPORT` evidence.

## Do Not

- Do not create a duty for a one-off issue comment.
- Do not put concrete implementation logic in `duty.md`.
- Do not hide observe plus act plus verify inside one duty.
- Do not let a duty own long-term progress or decide business completion.
- Do not let duties dispatch by bot-authored `@kody` comments; use workflow dispatch or in-process dispatch.
- Do not duplicate an existing store duty without a project-specific reason.
