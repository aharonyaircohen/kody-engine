# Jobs Model — Design Proposal

> **Status: IN PROGRESS.** Target architecture, mostly not built yet — don't treat it as current behavior. Progress is marked per item in "What changes" below (✅ done · 🚧 in progress · ⬜ not started).

## The idea

Everything the engine runs funnels into **one execution unit (the job)**, driven by a small set of clean structures. The fuzziness between "duty" and "executable" goes away because each concept answers a different question.

## The structures

| Concept | Answers | What it is |
|---|---|---|
| **persona** | who | reusable executor (`.kody/staff/<slug>.md`) |
| **duty** | why | reusable intent (pure prose) |
| **executable** | how | reusable unit of work (`run`, `fix`, …) |
| **issue** | what | a GitHub **issue or PR** — the work-item |
| **task** | execution | a **list of jobs** + state (the runs that do one issue) |
| **job** | the run | one execution (a retry = a new job) |
| **goal** | orchestration | a **list of issues** + state |

Nesting: **goal → issues → task → jobs.** A goal is a list of issues + state; each issue is done by a task (its list of jobs) + state; a job is a single execution.

## Trigger vs engine (two vocabularies)

- **Trigger side points at an issue:** `@kody [executable]` on an issue/PR says *what* to do and *on what*.
- **Engine side runs jobs:** it spawns a job for that issue; the issue's **task** is the list of jobs that result.

So you trigger on an **issue**; the **job** is the run; the **task** is the issue's run-history. A comment, a cron wake, and an orchestrator all funnel into **one runner** that executes jobs.

## Job I/O contract (the foundation)

Orchestration = wiring one job's output into the next job's input. So a job behaves like a near-pure function: **typed input → run → typed output.**

**Input**
- `target` — the issue **or** PR it acts on (not just "issue" — PR-ops exist)
- `executable` + `persona` — how + who
- `params` — args (base, feedback, complexity…)
- `upstream` — the previous job's output (the pipe; empty on a fresh trigger)

**Output**
- `status` — `ok | failed | skipped`
- `data` — typed result (`prUrl`, `sha`, `branch`…)
- `artifacts` — links produced (PR, comment, report)
- `next` — `{ cursor, data, done }` for stateful jobs, else `null`
- `reason` — one-line summary

The engine already emits every field, just scattered (`KODY_PR_URL`, `KODY_REASON`, exit codes `0/1/2/3`, the `kody-job-next-state {cursor,data,done}` fence). The change is to **return one typed object** instead of stdout signals + state files + GitHub labels.

## What changes

1. 🚧 **New `job`** — the single execution unit (binds duty + persona + executable + a target). *(`Job` type + `runJob` seam + `mintInstantJob`/`mintScheduledJob` landed in `src/job.ts`; nothing mints/runs them in the live paths yet.)*
2. ⬜ **Formalize `task` = a list of jobs + state** (the runs on one issue/PR). Today it's implicit (`taskState`/`loadTaskState`); make it the explicit layer between goal and job — a task holds its jobs.
3. ⬜ **Slim the duty** to pure *why*; schedule/persona/executable move onto the job.
4. ⬜ **`@kody` mints a job** (instant) instead of calling an executable directly — rewire dispatch.
5. ⬜ **Cron mints a job** (scheduled) — schedulers tick jobs.
6. ⬜ **Job points to one executable (0–1)** + safe dispatch — drop the fixed palette limit.
7. ⬜ **One runner** executes all jobs — collapse the separate paths.
8. ✅ **Servers** (`serve`/`pool-serve`/`runner-serve`/`brain-serve`) move to engine internals, out of the executable registry. *(Done — now `src/servers/` + hardcoded CLI verbs; gone from the registry.)*
9. ⬜ **`goal`** becomes the orchestration container (reuse the existing goal system): a **list of issues** + state, spawning jobs per issue.

Items 4 and 7 touch the execution core — the heavy lifting. The rest is wiring.

## Open question

**Does a re-run create a new job?**
- Yes → `task = [job]` earns its place (run history); keep both layers.
- No → task and job collapse; drop one layer.

This decides whether the task layer is real or ceremony.

## Rollout

Build on the **`next`** npm tag, prove it on one consumer (pin that repo's workflow to `@next`), promote to `latest` only when stable. Rollback = re-point the tag.
