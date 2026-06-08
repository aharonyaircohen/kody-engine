# Jobs Model — Reference

> **Status: IMPLEMENTED.** A task stores durable **jobs**: the required work for
> that issue/PR. Each job points to one executable and accumulates **runs**:
> execution attempts. Every trigger — an `@kody` comment, a cron wake, an
> orchestrator hand-off — still enters through `runJob` in
> [`src/job.ts`](../src/job.ts), but the stable task key is `jobKey`; the
> per-attempt id is `jobId`.

## The idea

The fuzziness between "what must be done" and "what happened this time" is gone:
a **job** is required work, and a **run** is one attempt to execute that work.
Retries stay under the same job instead of becoming new work.

## The structures

| Concept | Answers | What it is |
|---|---|---|
| **persona** | who | reusable executor identity (`.kody/staff/<slug>.md`; engine ships a built-in `kody`) |
| **duty** | why | reusable intent — the prose body of `.kody/duties/<slug>.md` |
| **executable** | how | reusable unit of work (`run`, `fix`, a duty's `profile.json`, …) |
| **issue** | what | a GitHub **issue or PR** — the work-item a task is about |
| **task** | task state | one issue/PR, its required jobs, outputs, and rolled-up state |
| **job** | required work | one planned unit of work on the task; points to exactly one executable |
| **run** | attempt | one execution attempt for a job; retries create more runs |
| **goal** | orchestration | a **list of tasks** + state (related work) |

Nesting: **goal → tasks → jobs → runs.** A goal is related tasks; a task is one
issue/PR; a job is required work inside that task; a run is one attempt.

## Trigger vs engine (two vocabularies)

- **Trigger side points at an issue:** `@kody [command] [free text]` on an
  issue/PR says *what* to do, *on what*, and (optionally) *why* in the operator's
  own words.
- **Engine side runs jobs:** it resolves the task job to execute, then records
  the attempt as a run under that job.

A comment, a cron wake, and an orchestrator hand-off all funnel into **one
runner** that executes a job attempt.

## The job

A `Job` ([`src/executables/types.ts`](../src/executables/types.ts)) binds the
four nouns plus its target and args. In task state, the durable job is stored in
`TaskState.jobs`; its runs are stored on `TaskJob.runs`.

- **who** — `persona` (a staff slug; instant jobs default to `kody`)
- **why** — `duty` (a reusable intent slug) **or** `why` (the operator's inline
  free-text request)
- **when** — `schedule` (a scheduled job's cadence; absent for instant)
- **how** — `executable` (the profile to run; 0–1)
- plus `target` (issue/PR number), `cliArgs`, and `flavor` (`instant` | `scheduled`).

`runJob(job, base)` lowers a job onto the generic executor. It seeds a stable
task job key (`jobKey`) plus per-run metadata (`jobId`, `jobFlavor`,
`jobSchedule`, `jobPersona`, `jobWhy`) into `ctx.data` so downstream scripts can
persist the run without the executor knowing task-state details.

### How each field is consumed

- **persona →** the executor loads `.kody/staff/<persona>.md` (or the built-in)
  and injects it as an authoritative-identity block. An executable's own
  declared `staff` wins when present; otherwise the job's persona applies. A
  missing built-in slug never crashes a consumer.
- **why (inline) →** the executor injects the operator's verbatim request as a
  **fenced, untrusted** "operator request" block in the system prompt, so the
  comment's wording shapes any executable's run — no per-prompt token needed.
  Structured comments (`resolve --prefer ours`) leave no free text → no `why`.
- **why (duty) →** the duty's prose body is the intent; the scheduled tick path
  surfaces it via the `{{jobIntent}}` prompt token.
- **when →** recorded on the task job and its run attempt so a scheduled job's
  cadence is visible in the task state.
- **how →** `runJob` dispatches exactly that one executable.

## The task = jobs + run history

A task is the `TaskState` ([`src/state.ts`](../src/state.ts)) for one issue/PR.
Its `jobs` map is the durable source of truth for required work. Each job has a
stable id, executable, optional duty/staff references, status, links, and a
capped `runs` list.

Its `history` remains a capped audit log of recent attempts. It is useful for
humans, but it is not the source of truth for whether the task's required work
is complete. The rolled-up `core` (phase, status, attempts, last outcome,
PR/run URLs) is the task's summary state.

## Plan-and-split tasks

A task can explicitly carry a small hidden plan that says "run these
executables as slices of this one task." The UI does not need to expose the word
**job**: a dashboard can present this as a duty with multiple executors, then
write the task data onto the issue:

```md
<!-- kody:task-jobs:v1
[
  { "executable": "db-migration", "reason": "schema slice" },
  { "executable": "api-worker", "reason": "API slice" },
  { "executable": "ui-builder", "reason": "UI slice" }
]
-->
```

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
- **Duty triggers, task state carries the plan.** A duty or dashboard may create
  the issue and hidden task data, but the duty does not wait on children.
  Rejected: adding waits/state to the duty loop, because duties are cron
  triggers.
- **No separate job storage.** The planned jobs live in the task state comment on
  the issue, beside the task summary and run history. Rejected:
  `.kody/jobs/`, because that splits one task's source of truth across two
  locations.
- **No new orchestration layer.** `task-jobs` is a small script-only executable
  on top of the existing `runJob` / `runExecutableChain` path. Rejected: a new
  orchestrator primitive or an "orchestrate" executable kind.

## The goal = a task list

A goal (`.kody/goals/`, driven by `goal-scheduler` / `goal-tick`) is a list of
tasks + state, spawning work per task. **Failure halts the goal:** a goal's
tasks are related, so if a task fails the goal stops and resumes only once that
task is fixed/retried — failures are not isolated.

## Status of the model

All structural items are implemented:

1. ✅ **Job** — durable required work on a task (`TaskState.jobs`) with one
   executable and a list of runs.
2. ✅ **Run** — one execution attempt. `runJob` seeds stable `jobKey` plus
   per-run `jobId`; `saveTaskState` appends the attempt under the task job and
   to `history`.
3. ✅ **Duty = pure why** — the duty's prose body is the intent; the job carries
   when/who/how, sourced from the duty's frontmatter at mint time. The
   frontmatter remains the authoring surface (removing it would break consumer
   authoring); the model treats it as job-config, not duty-essence.
4. ✅ **`@kody` mints an instant job** — the comment/manual route mints via
   `mintInstantJob` and runs through `runJob`. Persona (`kody`) and inline `why`
   are both consumed.
5. ✅ **Cron mints a scheduled job** — `dispatchJobFileTicks` mints one per due
   duty (`chain:false`), carrying its cadence.
6. ✅ **Job points to one executable (0–1)** + safe dispatch. The agent-driven
   `dutyMcp` palette is a separate, intentional safety mechanism, left intact.
7. ✅ **One runner** — comment, manual, and cron paths all run through `runJob`.
8. ✅ **Servers** (`serve` / `pool-serve` / `runner-serve` / `brain-serve`) are
   engine internals (`src/servers/` + hardcoded CLI verbs), out of the registry.
9. ✅ **Goal** — the orchestration container: a list of tasks + state, a job per
   task (`goal-scheduler` / `goal-tick` / `.kody/goals/`).
10. ✅ **Plan-and-split task execution** — `task-jobs` reads hidden issue task
    data, runs one child job per executable, waits in-process, summarizes the
    task, and retries failed children before later pending ones.

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
