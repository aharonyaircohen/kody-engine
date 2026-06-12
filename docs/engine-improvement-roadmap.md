# Kody engine improvement roadmap

> Detailed plan for the remaining phases. Phases 0–2 (partial) shipped to
> npm in this branch — see commits `2e3b472`, `e0f7c1f`, `4f17396`.
> Versions live: 0.4.43, 0.4.44, 0.4.45.

This document covers what's still to do, scoped phase-by-phase with
files, sub-tasks, risks, tests, and acceptance criteria. Each phase is
independently shippable; the order is dictated by dependencies, not
calendar.

---

## Status snapshot (end of session 2026-05-11)

| Phase | Status | Version | Verified |
|---|---|---|---|
| 0 — Instrumentation | Shipped | 0.4.43 | ✓ tester |
| 1 — Quick wins (6 of 9) | Shipped | 0.4.44 | ✓ tester |
| 2 / B4 — Typed `AgentOutcomeKind` | Shipped | 0.4.45 | ✓ tester |
| 2 / B3 — Prompt cache + TaskContext | Pending | — | — |
| 3 — Verify-as-inner-loop | Pending | — | — |
| 4 — Consolidation + draft-first | Pending | — | — |
| 5 — Single-process task run | Pending | — | — |
| 6 — Repo index (optional) | Pending | — | — |
| Remaining quick wins (3) | Pending | — | — |

Phase 1 still owes: **QW4** (commitAndPush idempotency), **QW5** (profile
JSON schema validation), **QW6** (structured postflight crash artifact).
These ride along with whichever phase touches their files next — see
each section below.

---

## Measurement baseline (prerequisite for Phase 5 sizing)

Before committing to the multi-week refactors (Phase 3 / 5), gather a
week of real metrics from the now-shipped instrumentation:

```bash
kody stats --since 7d --json > baseline.json
```

What we need to see:

| Metric | Why |
|---|---|
| Mean wall-clock per executable (run, plan, fix-ci) | Phase 5 scoping |
| Ratio of (GHA bootstrap time) ÷ (Claude active time) | Validates the "infra dominates" hypothesis |
| `fix-ci` invocation count per 100 feature tasks | Phase 3 ROI |
| Stalled-watchdog hits | Phase 1 effectiveness |
| Per-stage token costs (especially `cacheRead`) | Phase 2/B3 ROI |

If GHA bootstrap is <30 % of mean wall-clock, Phase 5's ROI is lower
than projected and Phase 3 should run first. If `fix-ci` is <10 % of
tasks, Phase 3's ROI is lower and Phase 5 should run first.

---

## Phase 2 — finish (prompt caching + TaskContext)

**Goal.** Make stage-to-stage chains pay full token cost once, then
~10–20 % per subsequent stage by caching a stable prefix and
consolidating context loading.

### Scope

- `src/agent.ts` — wire `excludeDynamicSections` and explicit
  cache-boundary support.
- New `src/scripts/loadTaskContext.ts` — single preflight that builds a
  typed `TaskContext` object and stashes `ctx.data.taskContext`.
- New `src/taskContext.ts` — typed schema + composition helpers.
- Each per-stage profile keeps its existing `loadIssueContext`,
  `loadConventions`, `loadPriorArt`, `loadMemoryContext`,
  `loadCoverageRules` chain working unchanged; new profiles can swap
  in `loadTaskContext` once.
- `composePrompt.ts` — accept either the old `ctx.data.*` fields or
  the new `ctx.data.taskContext` consolidated object.

### Sub-tasks

1. **Audit SDK caching surface.** Read full `sdk.d.ts` for
   `excludeDynamicSections`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, and any
   `cacheControl` option on `query()`. Identify which knobs the SDK
   exposes from outside (1–2 hours).
2. **Profile-level caching opt-in.** Add
   `claudeCode.cacheable: true` to profile JSON; when set, agent.ts
   passes `excludeDynamicSections: true`. Default false to avoid
   surprises (1 day).
3. **TaskContext schema** (`src/taskContext.ts`):
   ```ts
   interface TaskContext {
     issue: { number, title, body, labels, comments }
     conventions: string
     priorArt: PriorArt
     memory: Memory
     coverage: CoverageRules
     repoFacts: { defaultBranch, hasPackageManager: PM, … }
     schemaVersion: 1
   }
   ```
   Persist to `.kody/runs/<runId>/task-context.json` so children of a
   single task workflow can re-read it without re-querying GH.
4. **loadTaskContext preflight.** New script in `src/scripts/`.
   Composes existing loaders' outputs into the typed object.
5. **composePrompt update.** Inline TaskContext fields into the prompt
   with a stable preamble structure: `[mission preamble | task context
   block | stage-specific instructions]`. Place a cache marker between
   the second and third sections so changing only the stage-specific
   tail doesn't invalidate the prefix.
6. **Opt-in roll-out.** Switch `run`, `fix`, `fix-ci` profiles to
   `loadTaskContext` + `cacheable: true`. Leave `classify`, `plan`,
   `review` on the existing per-loader chain until we measure
   regression-free.

### Risks + mitigations

- **SDK doesn't expose what we need.** Fallback: prepare the cacheable
  prefix anyway, ship the TaskContext consolidation alone. The
  consolidation is independently valuable (smaller prompts, no
  cross-stage drift). Caching becomes a follow-up.
- **`excludeDynamicSections` breaks agent behaviour.** The re-injected
  user message must include the stripped content (cwd, git status,
  auto-memory) so the agent doesn't degrade. Verify each opt-in
  executable behaves identically on a tester smoke run before merging.

### Tests

- Unit: TaskContext composition + serialisation round-trip.
- Unit: `composePrompt` outputs cache-marker-bracketed structure when
  `cacheable: true`.
- Integration: postflight chain still produces `*_COMPLETED` action.
- Live: classify smoke on tester before each profile flips.

### Acceptance criteria

- `kody stats` shows `cacheRead > 0` on at least one stage of a
  multi-stage flow.
- Per-stage token cost drops ≥40 % from stage 2 onward in a real
  feature flow on the tester.
- No new errors in the live test for a week.

### Effort

5–7 working days.

---

## Phase 3 — verify-as-inner-loop (the stability spine)

**Goal.** Eliminate the most common "agent ran cleanly but PR failed
verify → human types `@kody fix-ci` → cold restart" round-trip. Move
verification inside the agent's session so it iterates against the
real signal up to a bounded budget.

### Scope

- New `src/scripts/verifyTool.ts` — exposes `verify` as a tool the
  agent can call. Likely implemented as an in-process synthetic MCP
  server (`src/plugins/verify/`) so the SDK discovers it via the
  existing plugin path mechanism.
- `src/scripts/verify.ts` — refactor: the heavy lifting is already
  here, extract the verifier into a reusable function callable from
  both the postflight ratifier and the tool.
- `src/executables/run/prompt.md` and `src/executables/fix/prompt.md`
  updated: instruct the agent to call `verify()` before declaring
  DONE, iterate up to N times on failure.
- `src/executables/run/profile.json` and `fix/profile.json` declare
  the new tool + a `maxVerifyAttempts` knob in `claudeCode` or in
  config.
- Per-iteration output truncation — only failing test names + first
  20 lines of each failure go back into the agent's context.

### Sub-tasks

1. **Extract `runVerification(cwd, config)`** from
   `src/scripts/verify.ts`. Pure function: runs typecheck/lint/test,
   returns `{ ok: boolean, failures: VerifyFailure[] }`. (1 day)
2. **Build verify MCP plugin.** A small Node-side MCP server in
   `src/plugins/verify/` exposing one tool: `verify` that calls
   `runVerification` and returns a truncated structured result. (2
   days)
3. **Wire into profiles.** Add the verify MCP to `run` and `fix`
   profiles' `mcpServers`. Update prompt.md with a contract:
   ```
   When you believe you're done:
   1. Call verify(). If `ok: true`, emit DONE.
   2. If `ok: false`, read the truncated failures, fix them, commit,
      call verify() again. You have up to {{maxVerifyAttempts}}
      attempts total before the run aborts.
   ```
3. **Cap per-iteration tokens.** Truncate the verify result to ≤2 KB
   of failure detail. Long suite logs go to `.kody/runs/<id>/verify-
   {iteration}.log` for post-mortem. (1 day)
4. **Keep the postflight `verify` as ratifier.** It still runs after
   the agent finishes — if the agent forgot to call the tool or it
   returns stale data, the postflight is the authoritative gate. No
   change to ensurePr / commitAndPush logic. (½ day)
5. **Per-attempt event emission.** Each tool call emits a
   `verify_attempt` event (new kind) with `{ ok, durationMs,
   failureCount, iteration }`. Lets `kody stats` report the
   distribution of iterations needed. (½ day)
6. **Bound runaway loops.** Hard cap on tool calls. If the agent calls
   `verify()` more than `maxVerifyAttempts` times, the tool starts
   returning `{ ok: false, locked: true, reason: "budget exhausted" }`
   so the agent's next text turn becomes its terminator. (½ day)

### Risks + mitigations

- **Agent doesn't call verify at all.** Mitigation: postflight verify
  still runs. The downside is the agent shipped without iterating,
  same as today. Net neutral.
- **Agent gets stuck in a verify-fix loop, burns tokens.** Mitigation:
  `maxVerifyAttempts` (default 4) + `maxTurns` global cap from Phase
  1.
- **Tool output exceeds context.** Mitigation: hard truncation step
  3.
- **Flaky tests cause false retries.** Mitigation: existing test-
  retry-on-flake logic in `runVerification` already handles this.

### Tests

- Unit: `runVerification` returns identical results to the existing
  postflight (regression).
- Unit: tool truncation caps output at ≤2 KB.
- Unit: budget exhaustion returns `locked: true`.
- Integration: mock agent that calls verify() once-success — flow
  ships. Mock that calls verify() until budget — flow aborts.
- Live: tester `@kody run` on a real issue with an intentionally
  broken test. Expect the agent to fix it and ship.

### Acceptance criteria

- Cumulative `fix-ci` invocations drop by ≥30 % over a 7-day window.
- `kody stats --json` shows `verify_attempt` events with a non-zero
  distribution above 1 (proving iteration happens).
- No regression in mean run-stage wall-clock for tasks that pass on
  first try.

### Effort

10–14 working days.

---

## Phase 4 — consolidation + draft-first UX

**Goal.** Reduce architectural sprawl (three near-identical fix
executables, comment-parsing-as-state, late PR creation) without
changing the agent loop. Most-bang-per-buck UX improvements.

### Sub-tasks

#### 4a. **QW15 — consolidate `fix` + `fix-ci` + `resolve` → `refine`** (medium)

- New `src/executables/refine/` with `profile.json` declaring a
  required `--mode` input enum: `feedback | ci | conflicts`.
- Three prompt files in the same dir: `prompt.feedback.md`,
  `prompt.ci.md`, `prompt.conflicts.md`. `composePrompt` selects by
  mode.
- Preflight chain switches per mode: `feedback` → existing `fixFlow`,
  `ci` → `fixCiFlow`, `conflicts` → `resolveFlow` +
  `apply-prefer.sh`.
- Dispatch aliases updated so `@kody fix` and `@kody fix-ci` and
  `@kody resolve` all route to `refine` with the correct mode.
- Old executables deleted; the `\b…\b` ordering hazard in
  `src/dispatch.ts` disappears.
- **Effort:** 3–4 days.

#### 4b. **QW14 — open draft PR at task start** (low)

- Container profile (`feature`/`bug`/`chore`) gains a new preflight
  `openTrackerPr` that creates a draft PR pointing at a fresh task
  branch as soon as the container starts, before any child runs.
- All stage results (`research`, `plan`, `review`) post their output
  to this PR's thread (vs. the original issue) — gives one
  consolidated view per task.
- `run` stage no longer creates the PR — it pushes to the existing
  branch.
- **Effort:** 2 days.

#### 4c. **QW13 — state.json artifact replacing GH comment parsing** (medium)

- New `src/scripts/saveTaskStateFile.ts` writes
  `.kody/runs/<runId>/state.json` to the PR branch on every
  postflight tick.
- `readTaskState` updated: prefer the file (one GH API call), fall
  back to comment-parsing if the file is missing (back-compat for
  in-flight tasks).
- Comment-based state stays as a human-readable mirror but is no
  longer authoritative.
- Adds `schemaVersion` (also closes **QW11**).
- **Effort:** 4 days.

#### 4d. **QW7 — per-goal/job tick lock** (low)

- `src/scripts/acquireLock.ts` / `releaseLock.ts` use a GH commit-on-
  branch as a mutex (`refs/kody/locks/<slug>`). If acquire fails the
  tick exits clean — next wake will retry.
- Wire into `goal-tick` and `duty-tick` preflight.
- **Effort:** 2 days.

#### 4e. **QW8 — container reset opt-in** (low)

- Container profile gains a `resetBetweenChildren: boolean` field
  (default `true` for back-compat). Profiles that prefer to keep
  generated files across children (e.g. `bug` letting `reproduce`'s
  failing test stay in tree) flip it to `false`.
- Eliminates one source of recent crashes.
- **Effort:** ½ day.

#### 4f. **QW4 — commitAndPush idempotency** (low)

- `src/scripts/commitAndPush.ts` writes a sentinel file
  `.kody/runs/<runId>/commit-<stage>.lock` on first run. Subsequent
  calls in the same task no-op + log.
- **Effort:** ½ day.

#### 4g. **QW5 — profile JSON schema validation** (low)

- Author `src/executables/profile.schema.json` from the TS types.
- `loadProfile` validates against it; unknown top-level keys raise an
  error (was silently dropping today).
- **Effort:** 1 day.

#### 4h. **QW6 — structured postflight crash artifact** (low)

- On postflight crash, executor writes
  `.kody/runs/<runId>/crashes/<postflight>-<ts>.json` with reason +
  stack. Today only stderr — gone after the runner shuts down.
- **Effort:** ½ day.

### Risks + mitigations

- **Refine consolidation breaks consumer aliases.** Mitigation: keep
  the old executable names as aliases routing into refine for one
  release cycle.
- **State.json + comment dual-write drift.** Mitigation: comment
  becomes a one-way mirror written by a single postflight; nobody
  reads it for routing.

### Tests

- Refine: existing fix / fix-ci / resolve test suites repointed at
  refine with the correct mode. All must pass unchanged.
- State.json: round-trip serialise/parse, schemaVersion enforcement.
- Lock: concurrent acquire returns one winner, one bounced.

### Acceptance criteria

- `kody-flow:fix-ci` label usage falls (one less alias to type).
- Draft PR present at task start: `gh pr view` returns a real URL
  within 30 s of `@kody` mention.
- No race on overlapping goal/job ticks (verified by deliberately
  triggering two wakes within the same minute on tester).

### Effort

12–15 working days total for 4a–4h.

---

## Phase 5 — single-process task run (B1, the speed spine)

**Goal.** Collapse the 5-stage GHA fan-out (5 separate workflow runs,
5×~90 s of bootstrap each) into one workflow run that walks the stage
machine in-process. Biggest absolute wall-clock saving in the
roadmap. Highest risk.

### Scope

- `src/executor.ts` — container loop gains an `inProcess: true`
  branch. When set, `__runChild` defaults to a direct
  `runExecutable(...)` call (already the case today!) but we also
  pass an opaque `taskContext` blob in `ctx.data` so children skip
  redundant GH round-trips.
- A new opt-in mode for consumer workflows: in `templates/kody.yml`,
  add no new YAML, but pass through a flag the engine reads — the
  container itself decides whether to walk children in-process or
  fire a sub-job. (Memory rule: do not touch YAML. Engine drives the
  decision.)
- Reuse Phase 2's TaskContext as the in-process handoff payload.
- Reuse Phase 4c's state.json as the in-process state store.

### Sub-tasks

1. **Bench the baseline.** Run 10 feature flows pre-change, capture
   `kody stats` mean wall-clock per stage. (½ day)
2. **In-process flag on container profile.**
   `children: [...]` already runs sequentially in-process today (see
   `runContainerLoop`); the missing piece is making the children
   skip their own `loadConfig`, `startLitellmIfNeeded`, MCP boot,
   `loadIssueContext`. Add `inProcess: true` to the container profile
   and have the executor pass a pre-loaded `__runtimeHandle` through
   `ctx.data` for children to detect and short-circuit. (3–5 days)
3. **Skip-on-handoff scripts.** Each preflight that should be cheap
   when handed off (`loadIssueContext`, `loadConventions`,
   `loadPriorArt`, `loadCoverageRules`) checks for
   `ctx.data.taskContext` and returns early. (2 days)
4. **Single litellm + single MCP pool.** Container's
   `startLitellmIfNeeded` runs once before the loop; children inherit
   the handle. MCP plugin paths resolved once. (2 days)
5. **Working-tree reset gated by `QW8`.** With shared state, children
   may legitimately want to see each other's generated files. (½ day,
   depends on Phase 4e)
6. **Pilot on `chore` flow.** Chore has the fewest children (`run` →
   `review` → maybe `fix`) and is lowest blast radius. Run a week.
   (1 week observation)
7. **Roll out to `bug`, then `feature`.** One per week with
   measurement gates. (2–3 weeks)

### Risks + mitigations

- **State leaks between children.** Mitigation: keep the working-tree
  reset opt-in (default on for first roll-out), explicit `taskContext`
  schema, no other shared state allowed.
- **Container child crash drags down the whole task.** Mitigation:
  child failures already route via `next` table — no behaviour
  change. Aggregate exit code via `worstExit` already works.
- **Hard to roll back.** Mitigation: every container profile change
  is a single field flip (`inProcess: false`). The legacy multi-run
  path stays functional indefinitely.

### Tests

- Unit: child resolution skip when `taskContext` present.
- Integration: full chore flow in-process produces identical state
  comment + PR + labels as out-of-process.
- Live: A/B on tester — half of `@kody chore` tasks routed in-process
  via a config flag, measured for a week.

### Acceptance criteria

- Mean `chore` wall-clock drops by ≥40 % on tester.
- No new failure modes in 100 sequential runs.
- `kody stats` shows the same `stage_end` outcomes as the legacy
  path.

### Effort

15–20 working days (3-week minimum, including pilots).

---

## Phase 6 — Pre-indexed repo (optional, B5)

Gate this phase on Phase 0 token data. If after Phase 2 + Phase 5 the
average `run` stage still spends ≥30 % of its tokens on Read/Grep tool
calls (visible in the `assistant` messages of the NDJSON log), do
this. Otherwise skip.

### Scope

- New cliTool/MCP `repo-index` that:
  - At task start, embeds each tracked file ≤200 lines (or chunks
    bigger files at module / function boundaries).
  - Stores embeddings + symbol graph in
    `.kody/index/<contentHash>.sqlite` (sqlite-vec) or in a Pinecone
    namespace per repo.
  - Exposes a `repo_search(query, topK)` tool to the agent.
- One-shot indexer script `src/scripts/buildRepoIndex.ts`.
- `composePrompt` mentions the tool.

### Sub-tasks

1. Decide embedding backend (sqlite-vec local vs Pinecone managed) —
   measure index build time + query latency.
2. Build the indexer with content-hash caching (skip re-index when
   nothing changed).
3. Wire as MCP server in `run`/`plan`/`review` profiles.
4. Measure.

### Effort

10–15 working days, lower priority.

---

## Sequencing recommendation

```
Week 1  → measure current production (kody stats), 7-day baseline
Week 2  → Phase 2/B3 (TaskContext + caching opt-in on run/fix/fix-ci)
Week 3-4 → Phase 3 (verify-as-inner-loop)
Week 5-6 → Phase 4 (refine consolidation + state.json + locks + remaining QWs)
Week 7-9 → Phase 5 pilot on chore, then bug, then feature
Week 10  → Phase 6 evaluation (decide go/no-go based on token data)
```

Total: 9–10 weeks of focused work. Each week's deliverable is a
shipped version on npm + live-tested on the tester repo.

---

## Operating model going forward

1. **One phase per session.** Mix-and-match risks dropping a phase
   half-done. Each session ends with a published version + a live-
   verified run.
2. **Version bump per phase.** 0.4.x patch by default. Major bump only
   if a container child contract changes (Phase 4a, Phase 5 in-process
   handoff).
3. **No feature branches in kody-engine.** Commits land on `main`,
   tag, push, publish — per project memory.
4. **Live-test gate.** Each phase's first sanity check is a fresh
   `@kody classify` smoke on the tester. Real feature/bug flows
   follow once the smoke passes.
5. **Rollback path.** Every change preserves the legacy mode behind a
   flag. If Phase 5 in-process mode breaks something, flip
   `inProcess: false` and the multi-run path keeps working.

---

## Open questions for human review

1. **Phase 2/B3 caching depth.** Is it worth doing the
   `excludeDynamicSections` opt-in alone (small win, low effort) before
   committing to the full TaskContext refactor? My take: yes — ship
   that as 2a in a single PR.
2. **Phase 3 budget.** Default `maxVerifyAttempts` of 4 — is that
   right? Lower means failed runs sooner; higher means more wasted
   tokens on stuck agents.
3. **Phase 4a refine collapse.** Do we deprecate `@kody fix`
   immediately or keep the alias forever? Alias forever is friendlier.
4. **Phase 5 pilot duration.** I proposed 1 week per executable
   (`chore`, then `bug`, then `feature`). Acceptable cadence?
5. **Phase 6 backend.** Pinecone (managed, per project memory) or
   sqlite-vec (local, zero infra)? My take: sqlite-vec because the
   index is repo-scoped and rebuilds on every release branch anyway.

End of document.
