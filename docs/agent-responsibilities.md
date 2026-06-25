# AgentResponsibilities

AgentResponsibilities are reusable capability contracts.

A agentResponsibility explains why a capability exists, who normally owns it, when it may run,
and which agentAction implements it. A agentResponsibility should not own a full process. It
should receive input, do one kind of work, and return structured output or agentResponsibility
report evidence that another layer can consume.

```text
input -> run -> structured output
```

## Core Rule

Each normal agentResponsibility should mainly do one type of work:

| Kind | Work | Meaning |
| --- | --- | --- |
| `observe` | inspect | Check current state and return facts, alerts, or suggested next actions. |
| `act` | change | Create, modify, trigger, publish, merge, deploy, or otherwise perform a requested action. |
| `verify` | confirm | Decide whether a specific claim passed or failed, with evidence and blockers. |

These are not three top-level models. The top-level model remains `AgentResponsibility`.
`capabilityKind` classifies the agentResponsibility's capability promise and selects the result
shape expected from that capability.

## What AgentResponsibilities Are Not

A agentResponsibility is not a goal, manager loop, or hidden workflow.

Do not put long-term progress ownership inside a agentResponsibility. If work needs multiple
steps, routing, waiting, or business completion decisions, model that above the
agentResponsibility:

| Responsibility | Correct home |
| --- | --- |
| Decide what outcome is complete | Goal |
| Choose next missing evidence | Goal manager |
| Track required issue/PR work and attempts | Task/job/run state |
| Do one reusable inspect/change/confirm action | AgentResponsibility plus agentAction |
| Persist factual evidence back to a goal | AgentResponsibility report via `applyAgentResponsibilityReports` |

The important boundary is:

```text
Goal decides what is needed.
AgentResponsibility provides one reusable capability.
AgentAction performs the concrete work.
```

## State Boundary

AgentActions and agentResponsibilities are reusable definitions. They can run many times with new inputs, but they should not remember long-term business progress.

- `agentAction`: concrete execution; emits output or reports for this run.
- `agentResponsibility`: capability contract; explains why/when/who/how and maps to one action or a small ordered action list.
- `goal`: durable outcome state; owns destination evidence, stage, facts, and blockers.
- `agentLoop`: durable cadence state; owns heartbeat/cursor data and the target it wakes.

A scheduled agentResponsibility may have an operational ledger for cursors or deduplication. That ledger is not goal progress. If the system needs to decide what is complete or which step is next, put that in a goal or agentLoop, not in the responsibility.

## Canonical Shape

AgentResponsibilities live in project `.kody/agent-responsibilities/` or in the company store:

```text
.kody/agent-responsibilities/<slug>/
  profile.json
  agent-responsibility.md
```

`profile.json` is metadata and routing. `agent-responsibility.md` is human-owned intent.

Example:

```json
{
  "name": "release-prepare",
  "action": "release-prepare",
  "agentAction": "release-prepare",
  "capabilityKind": "act",
  "describe": "Prepare a release pull request."
}
```

## Field Contract

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | AgentResponsibility slug. Must match the folder name. |
| `describe` | yes | Short responsibility summary. |
| `capabilityKind` | recommended | Capability promise: `observe`, `act`, or `verify`. |
| `action` | optional | Public action name. If absent, defaults to agentResponsibility name. |
| `agentAction` | usually | Implementation agentAction, the concrete how. |
| `agentActions` | optional | Ordered agentAction list for split task work. Use sparingly. |
| `agent` | optional | Agent identity, the who. |
| `every` | optional | Scheduler cadence. Use `manual` for on-demand agentResponsibilities. |
| `mentions` | optional | GitHub logins to mention in agentResponsibility output. |
| `agentResponsibilityTools` | optional | Locked agentResponsibility MCP tool names. |
| `disabled` | optional | Prevents scheduled execution. |

`role` and `kind` still belong to agentAction execution mechanics:

| Field | Answers |
| --- | --- |
| `role` | What kind of agentAction runtime shape is this? |
| `kind` | Is the agentAction oneshot or scheduled? |
| `capabilityKind` | What capability promise does this agentResponsibility make? |

## Result Models

`capabilityKind` maps to one validated result model.

### Observe

Observe agentResponsibilities inspect state and report what is true.

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

Do not dispatch repairs from an Observe agentResponsibility. Return facts or suggestions; let
a goal, task plan, or operator choose the next Act agentResponsibility.

### Act

Act agentResponsibilities perform a requested change or trigger an operation.

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

Act agentResponsibilities may report evidence such as `releasePrExists`, `mainMerged`, or
`productionDeployed`, but they do not decide the whole goal is complete.

### Verify

Verify agentResponsibilities confirm whether a specific claim is true.

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

Do not fix the thing from a Verify agentResponsibility. If verification fails, return evidence
and blockers so another layer can choose the next Act agentResponsibility.

## AgentResponsibility Results

AgentResponsibilities return one standard machine result:

```text
KODY_AGENT_RESPONSIBILITY_RESULT={"version":1,"status":"pass","summary":"CI is green.","facts":{"pr":123},"artifacts":[],"missingEvidence":[],"blockers":[]}
```

Rules:

- `status` must be `pass`, `fail`, `blocked`, `changed`, or `noop`.
- `summary` is required and should be short.
- `facts` is machine data for the parent agentGoal or agentLoop.
- `artifacts` is optional links or paths.
- `missingEvidence` names expected evidence still not proven.
- `blockers` names concrete blockers the parent should recover from or stop on.
- The agentResponsibility result says what happened; the parent decides progress and output.

## AgentResponsibility Reports

Many current agentActions report goal evidence through stdout instead of a full
capability result object:

```text
KODY_AGENT_RESPONSIBILITY_REPORT={"target":{"type":"goal","id":"web-release"},"evidence":{"releasePrExists":true},"facts":{"releasePr":338}}
```

Rules:

- Reports are factual.
- Reports may set evidence and facts.
- Reports must not set `state`, `stage`, `route`, `agentResponsibilities`, `destination`, or `blockers`.
- Profiles that emit reports should include `applyAgentResponsibilityReports` in postflight.

## Composition Example

A web release should stay a goal route, not one giant release agentResponsibility:

| Goal evidence | AgentResponsibility | Kind | AgentAction |
| --- | --- | --- | --- |
| `releasePrExists` | `release-prepare` | `act` | `release-prepare` |
| `mainMerged` | `release-merge` | `act` | `release-merge` |
| `productionDeployed` | `vercel-production-deploy` | `act` | `vercel-production-deploy` |

The goal decides the next missing evidence. Each agentResponsibility performs one reusable
capability and reports evidence. GitHub may close the release issue through
normal PR auto-close syntax, but the goal still owns release progress.

## Creating A AgentResponsibility

Use this checklist:

1. Ask whether the capability already exists.
2. Name the agentResponsibility by the one capability it provides, not the whole process.
3. Choose exactly one `capabilityKind`: `observe`, `act`, or `verify`.
4. Put the concrete work in an agentAction.
5. Add `agent` only when a specific agent matters.
6. Add `every` only when the agentResponsibility is scheduled.
7. Write `agent-responsibility.md` with purpose, inputs, outputs, allowed actions, and restrictions.
8. Emit `KODY_AGENT_RESPONSIBILITY_RESULT` with the agentResponsibility outcome.
9. If the agentResponsibility serves a current managed goal, also emit factual `KODY_AGENT_RESPONSIBILITY_REPORT` evidence.

## Do Not

- Do not create a agentResponsibility for a one-off issue comment.
- Do not put concrete implementation logic in `agent-responsibility.md`.
- Do not hide observe plus act plus verify inside one agentResponsibility.
- Do not let a agentResponsibility own long-term progress or decide business completion.
- Do not let agentResponsibilities dispatch by bot-authored `@kody` comments; use workflow dispatch or in-process dispatch.
- Do not duplicate an existing store agentResponsibility without a project-specific reason.
