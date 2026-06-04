# Jobs Model — Reference

> **Status: IMPLEMENTED.** Everything the engine runs is a **job**. Every trigger
> — an `@kody` comment, a cron wake, an orchestrator hand-off — mints a job and
> runs it through one runner (`runJob` in [`src/job.ts`](../src/job.ts)). The job
> carries *who* (persona), *why* (the request/duty), *when* (schedule), and *how*
> (executable); each run is recorded in the task's job ledger. This document is
> the reference for that model, not a proposal.

## The idea

The fuzziness between "duty" and "executable" is gone because each concept
answers a different question, and they all compose into one execution unit — the
**job**. You never run an executable directly; you mint a job that references
one.

## The structures

| Concept | Answers | What it is |
|---|---|---|
| **persona** | who | reusable executor identity (`.kody/staff/<slug>.md`; engine ships a built-in `kody`) |
| **duty** | why | reusable intent — the prose body of `.kody/duties/<slug>.md` |
| **executable** | how | reusable unit of work (`run`, `fix`, a duty's `profile.json`, …) |
| **issue** | what | a GitHub **issue or PR** — the work-item a task is about |
| **task** | run-history | the **ordered list of jobs** on one issue/PR + rolled-up state |
| **job** | the run | one execution (**a re-run is a new job**) |
| **goal** | orchestration | a **list of tasks** + state (related work) |

Nesting: **goal → tasks → jobs.** A goal is a list of tasks + state; a task is
the list of jobs (about one issue/PR) + state; a job is a single execution.

## Trigger vs engine (two vocabularies)

- **Trigger side points at an issue:** `@kody [command] [free text]` on an
  issue/PR says *what* to do, *on what*, and (optionally) *why* in the operator's
  own words.
- **Engine side runs jobs:** it mints a job for that issue and runs it; the
  issue's **task** is the list of jobs that result.

A comment, a cron wake, and an orchestrator hand-off all funnel into **one
runner** that executes jobs.

## The job

A `Job` ([`src/executables/types.ts`](../src/executables/types.ts)) binds the
four nouns plus its target and args:

- **who** — `persona` (a staff slug; instant jobs default to `kody`)
- **why** — `duty` (a reusable intent slug) **or** `why` (the operator's inline
  free-text request)
- **when** — `schedule` (a scheduled job's cadence; absent for instant)
- **how** — `executable` (the profile to run; 0–1)
- plus `target` (issue/PR number), `cliArgs`, and `flavor` (`instant` | `scheduled`).

`runJob(job, base)` lowers a job onto the generic executor. It seeds the job's
identity and metadata into `ctx.data` (`jobId`, `jobFlavor`, `jobSchedule`,
`jobPersona`, `jobWhy`) so downstream scripts and the executor can consume them
without the executor knowing anything about jobs.

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
- **when →** recorded on the job's ledger entry so a scheduled job's cadence is
  visible in the task state.
- **how →** `runJob` dispatches exactly that one executable.

## The task = a job ledger

A task is the `TaskState` ([`src/state.ts`](../src/state.ts)) for one issue/PR.
Its `history` is the **ordered list of job records** — each run appends one entry
carrying `jobId`, `flavor`, `schedule`, per-job `status`, `runUrl`, the
executable, and the staff it ran as. Because **a re-run is a new job**, a retry
appends a new entry rather than mutating the prior one — so the task is a true
run-history, not a single mutable slot. The rolled-up `core` (phase, status,
attempts, last outcome, PR/run URLs) is the task's summary state.

## The goal = a task list

A goal (`.kody/goals/`, driven by `goal-scheduler` / `goal-tick`) is a list of
tasks + state, spawning a job per task. **Failure halts the goal:** a goal's
tasks are related, so if a task fails the goal stops and resumes only once that
task is fixed/retried — failures are not isolated.

## Status of the model

All structural items are implemented:

1. ✅ **Job** — the single execution unit (`Job` + `runJob` + `mintInstantJob` /
   `mintScheduledJob`). Every trigger mints one.
2. ✅ **Task = list of jobs + state** — `TaskState.history` is the job ledger;
   each run appends a job record (`jobId`/`flavor`/`schedule`/`status`/`runUrl`).
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

## Decided

- **A re-run is a new job.** The task layer is real run-history, not ceremony:
  each run is a distinct job appended to the task's ledger.
- **Failure halts the goal** (related tasks; failures are not isolated).

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
