# Jobs Model — Reference

> **Status: IMPLEMENTED.** A task stores durable **jobs**: the required work for
> that issue/PR. Each job runs a workflow and accumulates **runs**: execution
> attempts. Every trigger — an `@kody` comment, a cron wake, an orchestrator hand-off — still enters through `runJob` in
> [`src/job.ts`](../src/job.ts), but the stable task key is `jobKey`; the
> per-attempt id is `jobId`.

## The idea

The fuzziness between "what must be done" and "what happened this time" is gone:
a **job** is required work, and a **run** is one attempt to execute that work.
Retries stay under the same job instead of becoming new work.

## The structures

| Concept | Answers | What it is |
|---|---|---|
| **intent** | why | company-level reason, priority, posture, scope, and success signals |
| **goal** | what | durable outcome + manager loop; stores destination evidence, route, facts, blockers, and progress |
| **agentLoop** | when | stateful heartbeat wrapper; stores schedule/cursor and wakes another target such as a goal or capability |
| **agent** | who | reusable executor identity (`.kody/agents/<slug>.md`, usually from project or company store) |
| **capability** | how | reusable ability the agency can use; currently stored as an capability contract plus an executable implementation |
| **workflow** | how, composed | ordered capability steps for one engine run; default workflow is one capability |
| **issue** | what | a GitHub **issue or PR** — the work-item a task is about |
| **task** | task state | one issue/PR, its required jobs, outputs, and rolled-up state |
| **job** | required work | one planned unit of work on the task; runs the default one-step workflow or an explicit workflow |
| **run** | attempt | one execution attempt for a job; retries create more runs |
| **capability** | storage | current storage name for a capability contract: public action, kind, agent, cadence, safety, inputs, outputs, and implementation link |
| **executable** | storage | current storage name for a capability implementation: prompt glue, scripts, skills, tools, and executor profile |

Compact mapping: **intent = why**, **goal = what**, **agentLoop = when**,
**agent = who**, **capability/workflow = how**.

Current storage mapping: **capability = capability contract** and
**executable = capability implementation**.

The CTO `company-manager` loop reads intent and performs portfolio
orchestration. It may create or adjust goals and agentLoops, but goal-manager
still owns step-by-step execution inside each goal.

Nesting: **goal → tasks → jobs → runs.** A managed goal is the outcome manager
above tasks. Legacy stacked goals are archived migration state, not a parallel
model. A task is one issue/PR; a job is required work inside that task; a run is
one attempt.

State boundary: executables and capabilities are reusable definitions.
They should be stateless with respect to business progress. Goals and agentLoops
are stateful instances. A scheduled capability may keep only operational
cursor/dedup state; it must not own goal progress or decide completion.

Canonical creation docs:

- [Goals](goals.md)
- [Capabilities](capabilities.md)
- [Agent](agents.md)
- [Executables](executables.md)

## Trigger vs engine (two vocabularies)

- **Trigger side points at an issue:** `@kody [command] [free text]` on an
  issue/PR says *what* to do, *on what*, and (optionally) *why* in the operator's
  own words.
- **Engine side runs jobs:** it resolves the task job to execute, then records
  the attempt as a run under that job.

A comment, a cron wake, and an orchestrator hand-off all funnel into **one
runner** that executes a job attempt.

## The workflow

A workflow is the run shape around capabilities:

```text
input -> capability steps -> final output
```

Every job effectively runs a workflow. For normal capabilities, the default
workflow has one step. A capability may also declare an explicit workflow:

```json
{
  "name": "bug",
  "action": "bug",
  "workflow": {
    "steps": [
      { "capability": "reproduce", "reason": "capture the failing test" },
      { "capability": "run", "reason": "fix the bug using the repro artifact" }
    ]
  }
}
```

The workflow owns only step order, shared step results, and the final run
output. It does not own intent, goal progress, schedule, or agent identity.

## The job

A `Job` ([`src/executables/types.ts`](../src/executables/types.ts)) binds the
four nouns plus its target and args. In task state, the durable job is stored in
`TaskState.jobs`; its runs are stored on `TaskJob.agentRuns`.

- **who** — `agent` (an agent slug; instant jobs default to `kody`)
- **why** — `why` (the operator's inline free-text request, intent, or goal context)
- **when** — `schedule` (a scheduled job's cadence; absent for instant)
- **how** — a workflow; default is one capability implementation, stored as `executable`
- **capability contract** — optional `capability`, the storage record that minted or
  authorized the job
- plus `target` (issue/PR number), `cliArgs`, and `flavor` (`instant` | `scheduled`).

`runJob(job, base)` lowers a job onto the generic executor. It seeds a stable
task job key (`jobKey`) plus per-run metadata (`jobId`, `jobFlavor`,
`jobSchedule`, `jobAgent`, `jobWhy`) into `ctx.data` so downstream scripts can
persist the run without the executor knowing task-state details.

### How each field is consumed

- **agent →** the executor loads `.kody/agents/<agent>.md` from the project
  or company store and injects it as an authoritative-identity block. An
  executable's own declared `agent` wins when present; otherwise the job's
  agent applies. Missing agent is a hard error.
- **why (inline) →** the executor injects the operator's verbatim request as a
  **fenced, untrusted** "operator request" block in the system prompt, so the
  comment's wording shapes any executable's run — no per-prompt token needed.
  Structured comments (`resolve --prefer ours`) leave no free text → no `why`.
- **capability contract (capability) →** the capability's prose body is the
  capability purpose and output contract; the scheduled tick path surfaces it via
  the compatibility `{{jobIntent}}` prompt token.
- **when →** recorded on the task job and its run attempt so a scheduled job's
  cadence is visible in the task state.
- **how →** `runJob` executes the capability workflow. The default workflow
  dispatches one executable; an explicit workflow runs ordered capability steps.

## The task = jobs + run history

A task is the `TaskState` ([`src/state.ts`](../src/state.ts)) for one issue/PR.
Its `jobs` map is the durable source of truth for required work. Each job has a
stable id, executable, optional capability/agent references, status, links, and a
capped `runs` list.

Its `history` remains a capped audit log of recent attempts. It is useful for
humans, but it is not the source of truth for whether the task's required work
is complete. The rolled-up `core` (phase, status, attempts, last outcome,
PR/run URLs) is the task's summary state.

## Plan-and-split tasks

A task can explicitly carry a small hidden plan that says "run these
executables as slices of this one task." The UI does not need to expose the word
**job**: a dashboard can present this as a capability with multiple implementations, then
write the task data onto the issue:

```md
<!-- kody:task-jobs:v1
[
  { "executable": "db-migration", "reason": "schema slice" },
  { "executable": "api-agent", "reason": "API slice" },
  { "executable": "ui-builder", "reason": "UI slice" }
]
-->
```

For scheduled capabilities, the authoring surface is even simpler: the capability profile
can declare the executable list directly:

```json
{
  "name": "feature-progress",
  "every": "1h",
  "agent": "kody",
  "executables": ["db-migration", "api-agent", "ui-builder"]
}
```

The matching `capability.md` body explains what capability exists and
what output or evidence it should return.

When that capability is due, `capability-scheduler` creates one GitHub issue with the hidden
task data above, records the issue number in the capability state, and runs
`task-jobs` against that issue.

`task-jobs` reads that block, seeds `TaskState.jobs`, and dispatches one child
job per executable. Each child still has exactly one executable. After a child
succeeds, the engine returns to `task-jobs` in-process and dispatches the next
unfinished child. When all planned jobs are succeeded, the task state renders
`Jobs: N/N complete` and the recent history shows the slices that ran.

Failure is intentionally conservative: a failed child stops the current
workflow run. A manual rerun retries the first non-succeeded planned job before
moving to later pending jobs, so failed work is not skipped.

### Decisions and rejected alternatives

- **Engine splits, executables do not.** An executable remains a leaf expert and
  receives an already-scoped slice. Rejected: putting split logic in the
  executable, because that turns the expert into a coordinator.
- **Capability declares, engine splits.** A capability may carry `executables: a, b, c`;
  `capability-scheduler` creates the task issue and `task-jobs` waits on the children.
  Rejected: making the capability itself poll child state, because capabilities are cron
  triggers.
- **No consumer-repo job storage.** The planned jobs live in task state under
  `stateRepo`; the issue/PR comment is only a readable mirror. Rejected:
  `.kody/jobs/` in the consumer repo, because that contaminates product history.
- **No new orchestration layer.** `task-jobs` is a small script-only executable
  on top of the existing `runJob` / `runExecutableChain` path. Rejected: a new
  orchestrator primitive or an "orchestrate" executable kind.

## The goal = outcome + manager loop

A goal is durable **what**. It names a destination and owns the manager loop that
moves toward that destination. It is above capabilities in meaning: capabilities
are reusable abilities the goal may use, not the goal itself.

The new company goal model is the **managed goal** contract stored in
`<statePath>/goals/instances/<id>/state.json` in `stateRepo`. The contract is:

- `destination` — outcome text plus ordered evidence names that define done.
- `capabilities` — capability contracts this goal is allowed to use.
- `route` — one step per evidence item; each step names stage, capability, optional
  executable, and optional args.
- `facts` — observed evidence and values reported by capabilities.
- `blockers` — reasons the manager loop could not safely dispatch next work.

Store goals are inactive templates. The consumer repo activates the goals it
wants through `company.activeGoals` in `kody.config.json`.

`goal-scheduler` wakes active goal files. If the file has the managed-goal
contract, it routes the tick to `goal-manager`. `goal-manager` finds the first
missing destination evidence, resolves route args from `facts`, dispatches the
responsible capability/executable, and records `facts.pendingEvidence`. A later
tick retries that same route step if the evidence is still missing; capability
reports set evidence facts true. When every destination evidence item is true,
the goal becomes `state: "done"`.

This replaces the old legacy goal flow. Real active agentGoals should be rewritten as managed goals; stale legacy goals should be closed or archived.

## Status of the model

All structural items are implemented:

1. ✅ **Job** — durable required work on a task (`TaskState.jobs`) with one
   executable and a list of runs.
2. ✅ **Run** — one execution attempt. `runJob` seeds stable `jobKey` plus
   per-run `jobId`; `saveTaskState` appends the attempt under the task job and
   to `history`.
3. ✅ **Capability contract storage** — the capability's prose body is
   the capability purpose and output contract; the job carries why/when/who/how,
   sourced from the operator request, goal/intent context, and the
   capability folder's `profile.json` at mint time. `capability.md`
   stays prose-only; metadata belongs in `profile.json`.
4. ✅ **`@kody` mints an instant job** — the comment/manual route mints via
   `mintInstantJob` and runs through `runJob`. Agent (`kody`) and inline `why`
   are both consumed.
5. ✅ **Cron mints a scheduled job** — `dispatchCapabilityFileTicks` mints one per due
   capability, carrying its cadence.
6. ✅ **Job points to one executable (0–1)** + safe dispatch. The agent-driven
   `capabilityMcp` palette is a separate, intentional safety mechanism, left intact.
7. ✅ **One runner** — comment, manual, and cron paths all run through `runJob`.
8. ✅ **Servers** (`serve` / `pool-serve` / `runner-serve` / `brain-serve`) are
   engine internals (`src/servers/` + hardcoded CLI verbs), out of the registry.
9. ✅ **Goal** — outcome + manager loop. Managed goals use `goal-manager` with
   destination/evidence/capabilities/route/facts/blockers.
10. ✅ **Plan-and-split task execution** — `task-jobs` reads hidden issue task
    data, runs one child job per executable, waits in-process, summarizes the
    task, and retries failed children before later pending ones.
11. ✅ **Capability-level multi-executable execution** — a due capability with
    `executables:` creates one task issue, records that issue on capability state, and
    runs `task-jobs` for the listed executables.

## Decided

- **A re-run is a new run, not a new job.** Retries append attempts under the
  same durable job when `jobKey` is stable.
- **Failure halts the goal** (related tasks; failures are not isolated).
- **Failure halts a split task run.** Rerun retries the failed planned job
  before dispatching later slices.

## Still open (future work)

These are genuinely unresolved and intentionally out of scope here:

- **Paused / `blocked` job status** for approval gates (a job that waits on a
  human before proceeding).
- **Same-issue serialization** — lock + supersede vs queue when a new trigger
  arrives mid-run.
- **Goal lifecycle** — who adds tasks, when a goal is "done", whether the goal
  itself is scheduled.

## Rollout

Build on the **`next`** npm tag, prove it on a consumer (pin that repo's
workflow to `@next`), promote to `latest` only when stable. Rollback = re-point
the tag.
