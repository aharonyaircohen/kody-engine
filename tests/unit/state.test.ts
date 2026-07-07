import { describe, expect, it } from "vitest"
import {
  type Action,
  CorruptStateError,
  emptyState,
  nextPendingTaskJob,
  parseStateComment,
  reduce,
  renderStateComment,
  STATE_BEGIN,
  STATE_END,
  upsertTaskJobs,
} from "../../src/state.js"

describe("state: emptyState", () => {
  it("has the expected initial shape", () => {
    const s = emptyState()
    expect(s.schemaVersion).toBe(1)
    expect(s.core.phase).toBe("idle")
    expect(s.core.status).toBe("pending")
    expect(s.core.currentImplementation).toBeNull()
    expect(s.core.lastOutcome).toBeNull()
    expect(s.core.attempts).toEqual({})
    expect(s.implementations).toEqual({})
    expect(s.jobs).toEqual({})
    expect(s.history).toEqual([])
  })
})

describe("state: reduce", () => {
  const ok: Action = { type: "RUN_COMPLETED", payload: { prUrl: "u" }, timestamp: "2026-04-20T09:00:00Z" }
  const fail: Action = { type: "RUN_FAILED", payload: { reason: "boom" }, timestamp: "2026-04-20T09:05:00Z" }

  it("increments attempts for the implementation", () => {
    const s1 = reduce(emptyState(), "build", ok)
    expect(s1.core.attempts).toEqual({ build: 1 })
    const s2 = reduce(s1, "build", fail)
    expect(s2.core.attempts).toEqual({ build: 2 })
  })

  it("records the latest action as lastOutcome and per-implementation lastAction", () => {
    const s = reduce(emptyState(), "build", ok)
    expect(s.core.lastOutcome).toEqual(ok)
    expect(s.implementations.build?.lastAction).toEqual(ok)
  })

  it("derives status=succeeded from *_COMPLETED", () => {
    expect(reduce(emptyState(), "build", ok).core.status).toBe("succeeded")
  })

  it("records the agent that ran (durable proof) in core + history + comment", () => {
    const s = reduce(emptyState(), "feature", ok, "shipped", "kody")
    expect(s.core.ranAsAgent).toBe("kody")
    expect(s.history.at(-1)?.agent).toBe("kody")
    expect(renderStateComment(s)).toContain("**Ran as:** `kody`")
    // round-trips through the comment wire format
    expect(parseStateComment(renderStateComment(s)).core.ranAsAgent).toBe("kody")
  })

  it("stamps job identity (id/flavor/runUrl) + per-job status onto the ledger entry", () => {
    const s = reduce(emptyState(), "run", ok, "shipped", null, {
      jobKey: "instant:run:42",
      jobId: "gh-77-1",
      flavor: "instant",
      runUrl: "https://ci/run/77",
    })
    const entry = s.history.at(-1)!
    expect(entry.jobId).toBe("gh-77-1")
    expect(entry.flavor).toBe("instant")
    expect(entry.runUrl).toBe("https://ci/run/77")
    expect(entry.status).toBe("succeeded")
  })

  it("creates durable task job data separate from the history log", () => {
    const s = reduce(emptyState(), "run", ok, "shipped", "kody", {
      jobKey: "instant:run:42",
      jobId: "gh-77-1",
      flavor: "instant",
      target: 42,
      agent: "kody",
      runUrl: "https://ci/run/77",
    })

    expect(Object.keys(s.jobs)).toEqual(["instant:run:42"])
    expect(s.jobs["instant:run:42"]).toMatchObject({
      id: "instant:run:42",
      implementation: "run",
      agent: "kody",
      flavor: "instant",
      target: 42,
      status: "succeeded",
      runUrl: "https://ci/run/77",
    })
    expect(s.jobs["instant:run:42"]?.agentRuns).toEqual([
      {
        id: "gh-77-1",
        timestamp: "2026-04-20T09:00:00Z",
        action: "RUN_COMPLETED",
        status: "succeeded",
        note: "u",
        runUrl: "https://ci/run/77",
        prUrl: "u",
      },
    ])
    expect(s.history.at(-1)?.jobId).toBe("gh-77-1")
  })

  it("keeps one durable job while appending retry runs underneath it", () => {
    let s = reduce(emptyState(), "run", fail, undefined, null, {
      jobKey: "instant:run:42",
      jobId: "gh-1-1",
      flavor: "instant",
    })
    s = reduce(s, "run", ok, "shipped", null, {
      jobKey: "instant:run:42",
      jobId: "gh-1-2",
      flavor: "instant",
    })

    expect(Object.keys(s.jobs)).toEqual(["instant:run:42"])
    expect(s.jobs["instant:run:42"]?.status).toBe("succeeded")
    expect(s.jobs["instant:run:42"]?.agentRuns.map((r) => r.id)).toEqual(["gh-1-1", "gh-1-2"])
    expect(s.jobs["instant:run:42"]?.agentRuns.map((r) => r.status)).toEqual(["failed", "succeeded"])
    expect(s.history.map((h) => h.jobId)).toEqual(["gh-1-1", "gh-1-2"])
  })

  it("tracks separate jobs by stable key", () => {
    let s = reduce(emptyState(), "run", ok, "shipped", null, {
      jobKey: "instant:run:42",
      jobId: "gh-run-1",
      flavor: "instant",
    })
    s = reduce(s, "review", ok, "reviewing", null, {
      jobKey: "instant:review:42",
      jobId: "gh-review-1",
      flavor: "instant",
    })

    expect(Object.keys(s.jobs).sort()).toEqual(["instant:review:42", "instant:run:42"])
    expect(s.jobs["instant:run:42"]?.implementation).toBe("run")
    expect(s.jobs["instant:review:42"]?.implementation).toBe("review")
  })

  it("caps run attempts per job while keeping the durable job", () => {
    let s = emptyState()
    for (let i = 0; i < 25; i++) {
      s = reduce(s, "run", { type: "RUN_COMPLETED", payload: {}, timestamp: `t${i}` }, "shipped", null, {
        jobKey: "instant:run:42",
        jobId: `gh-${i}`,
        flavor: "instant",
      })
    }

    expect(s.jobs["instant:run:42"]?.agentRuns.length).toBe(20)
    expect(s.jobs["instant:run:42"]?.agentRuns[0]?.id).toBe("gh-5")
    expect(s.jobs["instant:run:42"]?.agentRuns.at(-1)?.id).toBe("gh-24")
  })

  it("stores capability, implementation, and agent as references instead of reshaping them", () => {
    const s = reduce(emptyState(), "capability-tick", ok, "idle", "triager", {
      jobKey: "scheduled:triage:capability-tick",
      jobId: "gh-9-1",
      flavor: "scheduled",
      schedule: "*/5 * * * *",
      capability: "triage",
      implementation: "capability-tick",
      agent: "triager",
    })

    expect(s.jobs["scheduled:triage:capability-tick"]).toMatchObject({
      capability: "triage",
      implementation: "capability-tick",
      agent: "triager",
      flavor: "scheduled",
      schedule: "*/5 * * * *",
    })
  })

  it("records a scheduled job's cadence on its ledger entry", () => {
    const s = reduce(emptyState(), "watch-stale-prs", ok, "idle", "kody", {
      jobKey: "scheduled:watch-stale-prs",
      jobId: "gh-9-1",
      flavor: "scheduled",
      schedule: "7d",
    })
    expect(s.history.at(-1)?.flavor).toBe("scheduled")
    expect(s.history.at(-1)?.schedule).toBe("7d")
  })

  it("treats each run as a NEW job: re-running appends another ledger entry", () => {
    let s = reduce(emptyState(), "run", fail, undefined, null, { jobId: "gh-1-1", flavor: "instant" })
    s = reduce(s, "run", ok, "shipped", null, { jobId: "gh-1-2", flavor: "instant" })
    expect(s.history.length).toBe(2)
    expect(s.history.map((h) => h.jobId)).toEqual(["gh-1-1", "gh-1-2"])
    expect(s.history.map((h) => h.status)).toEqual(["failed", "succeeded"])
  })

  it("omits job fields when no JobMeta is supplied (backward-compatible)", () => {
    const entry = reduce(emptyState(), "build", ok).history.at(-1)!
    expect(entry.jobId).toBeUndefined()
    expect(entry.flavor).toBeUndefined()
    expect(entry.runUrl).toBeUndefined()
    // round-trips through the wire format
    const back = parseStateComment(
      renderStateComment(reduce(emptyState(), "build", ok, undefined, null, { jobId: "j1", flavor: "scheduled" })),
    )
    expect(back.history.at(-1)?.jobId).toBe("j1")
    expect(back.history.at(-1)?.flavor).toBe("scheduled")
  })

  it("leaves ranAsAgent null when no agent (legacy, no agent)", () => {
    const s = reduce(emptyState(), "build", ok)
    expect(s.core.ranAsAgent ?? null).toBeNull()
    expect(renderStateComment(s)).not.toContain("Ran as:")
  })

  it("derives status=failed from *_FAILED", () => {
    expect(reduce(emptyState(), "build", fail).core.status).toBe("failed")
  })

  it("appends to history (capped at 20)", () => {
    let s = emptyState()
    for (let i = 0; i < 25; i++) {
      s = reduce(s, "build", { type: "RUN_COMPLETED", payload: {}, timestamp: `t${i}` })
    }
    expect(s.history.length).toBe(20)
    expect(s.history.at(-1)!.timestamp).toBe("t24")
    expect(s.history[0]!.timestamp).toBe("t5")
  })

  it("is a no-op when action is null", () => {
    const s = emptyState()
    expect(reduce(s, "build", null)).toBe(s)
  })
})

describe("state: explicit task jobs", () => {
  it("seeds planned jobs as pending durable work", () => {
    const s = upsertTaskJobs(
      emptyState(),
      [
        { id: "instant:plan-verify:42", implementation: "plan-verify", flavor: "instant", target: 42, reason: "api" },
        { id: "instant:probe-skill:42", implementation: "probe-skill", flavor: "instant", target: 42, reason: "ui" },
      ],
      "2026-06-08T08:00:00Z",
    )

    expect(Object.keys(s.jobs)).toEqual(["instant:plan-verify:42", "instant:probe-skill:42"])
    expect(s.jobs["instant:plan-verify:42"]).toMatchObject({
      implementation: "plan-verify",
      status: "pending",
      target: 42,
      reason: "api",
      agentRuns: [],
    })
    expect(renderStateComment(s)).toContain("**Jobs:** 0/2 complete")
  })

  it("preserves completed runs when the plan is seen again", () => {
    const planned = {
      id: "instant:plan-verify:42",
      implementation: "plan-verify",
      flavor: "instant" as const,
      target: 42,
    }
    let s = upsertTaskJobs(emptyState(), [planned], "2026-06-08T08:00:00Z")
    s = reduce(
      s,
      "plan-verify",
      { type: "VERIFY_COMPLETED", payload: {}, timestamp: "2026-06-08T08:05:00Z" },
      "idle",
      null,
      {
        jobKey: "instant:plan-verify:42",
        jobId: "gh-1-1",
        flavor: "instant",
        target: 42,
      },
    )

    const replanned = upsertTaskJobs(s, [{ ...planned, reason: "updated plan text" }], "2026-06-08T08:10:00Z")

    expect(replanned.jobs["instant:plan-verify:42"]?.status).toBe("succeeded")
    expect(replanned.jobs["instant:plan-verify:42"]?.reason).toBe("updated plan text")
    expect(replanned.jobs["instant:plan-verify:42"]?.agentRuns.map((r) => r.id)).toEqual(["gh-1-1"])
  })

  it("selects the next pending planned job in plan order", () => {
    let s = upsertTaskJobs(
      emptyState(),
      [
        { id: "instant:plan-verify:42", implementation: "plan-verify", flavor: "instant", target: 42 },
        { id: "instant:probe-skill:42", implementation: "probe-skill", flavor: "instant", target: 42 },
      ],
      "2026-06-08T08:00:00Z",
    )
    s = reduce(
      s,
      "plan-verify",
      { type: "VERIFY_COMPLETED", payload: {}, timestamp: "2026-06-08T08:05:00Z" },
      "idle",
      null,
      { jobKey: "instant:plan-verify:42", jobId: "gh-1-1", flavor: "instant", target: 42 },
    )

    const next = nextPendingTaskJob(s, ["instant:plan-verify:42", "instant:probe-skill:42"])
    expect(next?.id).toBe("instant:probe-skill:42")
  })

  it("selects a failed planned job before later pending jobs so reruns retry the failed slice", () => {
    let s = upsertTaskJobs(
      emptyState(),
      [
        { id: "instant:plan-verify:42", implementation: "plan-verify", flavor: "instant", target: 42 },
        { id: "instant:probe-skill:42", implementation: "probe-skill", flavor: "instant", target: 42 },
      ],
      "2026-06-08T08:00:00Z",
    )
    s = reduce(
      s,
      "plan-verify",
      { type: "PLAN_VERIFY_FAILED", payload: { reason: "boom" }, timestamp: "2026-06-08T08:05:00Z" },
      "idle",
      null,
      { jobKey: "instant:plan-verify:42", jobId: "gh-1-1", flavor: "instant", target: 42 },
    )

    const next = nextPendingTaskJob(s, ["instant:plan-verify:42", "instant:probe-skill:42"])
    expect(next?.id).toBe("instant:plan-verify:42")
  })
})

describe("state: parseStateComment / renderStateComment", () => {
  it("round-trips a non-empty state", () => {
    const s1 = reduce(emptyState(), "build", {
      type: "RUN_COMPLETED",
      payload: { prUrl: "https://github.com/x/y/pull/1" },
      timestamp: "2026-04-20T09:00:00Z",
    })
    const body = renderStateComment(s1)
    expect(body).toContain(STATE_BEGIN)
    expect(body).toContain(STATE_END)
    expect(body).toContain("```json")
    const s2 = parseStateComment(body)
    expect(s2.core.lastOutcome?.type).toBe("RUN_COMPLETED")
    expect(s2.core.attempts.build).toBe(1)
  })

  it("returns empty state when sentinels are missing", () => {
    const s = parseStateComment("some random text without markers")
    expect(s).toEqual(emptyState())
  })

  it("throws CorruptStateError when the marker is present but JSON is malformed", () => {
    // Marker present + unparseable payload = corruption (truncated/clobbered
    // comment), NOT an empty task. Throwing lets the caller fail loud instead
    // of silently redoing committed work. (No-marker bodies still return
    // emptyState — see the test above.)
    const body = `${STATE_BEGIN}\n\n\`\`\`json\n{not valid\n\`\`\`\n${STATE_END}`
    expect(() => parseStateComment(body)).toThrow(CorruptStateError)
  })

  it("throws CorruptStateError when STATE_END is missing", () => {
    const body = `${STATE_BEGIN}\n\n\`\`\`json\n{"schemaVersion":1}\n\`\`\`\n`
    expect(() => parseStateComment(body)).toThrow(CorruptStateError)
  })

  it("preserves artifacts whose content contains triple-backtick code fences", () => {
    // Regression: the non-greedy regex previously used to extract the JSON
    // block would stop at the first ``` inside the plan artifact's content,
    // producing invalid JSON and dropping all prior state.
    const planWithFences = "## Files to create\n\n### `src/utils/x.ts`\n```ts\nexport function x() {}\n```\n\nDone."
    let s = reduce(emptyState(), "plan", {
      type: "PLAN_COMPLETED",
      payload: { commitMessage: "plan: x" },
      timestamp: "2026-04-22T08:23:00Z",
    })
    s = {
      ...s,
      artifacts: {
        ...s.artifacts,
        plan: {
          format: "markdown",
          producedBy: "plan",
          createdAt: "2026-04-22T08:23:00Z",
          content: planWithFences,
        },
      },
    }
    const body = renderStateComment(s)
    const reloaded = parseStateComment(body)
    expect(Object.keys(reloaded.artifacts)).toContain("plan")
    expect(reloaded.artifacts.plan?.content).toBe(planWithFences)
    expect(reloaded.history.length).toBe(1)
  })

  it("preserves state when artifact content embeds the literal STATE_END marker", () => {
    // Regression: parseStateComment used `indexOf(STATE_END, beginIdx + 1)`,
    // which matched the first occurrence — including any embedded inside the
    // artifact JSON when a plan discussed the kody state schema. That
    // truncated the slice, broke the JSON parse, and silently returned
    // emptyState — losing flow context and putting the orchestrator in an
    // infinite plan↔bug loop.
    const planContentWithMarkers = `Plan example:\n\n${STATE_BEGIN}\n\`\`\`json\n{}\n\`\`\`\n${STATE_END}\n\nDone.`
    let s = reduce(emptyState(), "plan", {
      type: "PLAN_COMPLETED",
      payload: { commitMessage: "plan: schema" },
      timestamp: "2026-04-28T08:00:00Z",
    })
    s = {
      ...s,
      flow: { name: "bug", step: "plan", issueNumber: 1380, startedAt: "2026-04-28T08:00:00Z" },
      artifacts: {
        plan: {
          format: "markdown",
          producedBy: "plan",
          createdAt: "2026-04-28T08:00:00Z",
          content: planContentWithMarkers,
        },
      },
    }
    const body = renderStateComment(s)
    const reloaded = parseStateComment(body)
    expect(reloaded.flow?.name).toBe("bug")
    expect(reloaded.core.lastOutcome?.type).toBe("PLAN_COMPLETED")
    expect(reloaded.artifacts.plan?.content).toBe(planContentWithMarkers)
  })

  it("round-trips durable jobs through the hidden state block", () => {
    const action: Action = { type: "RUN_COMPLETED", payload: { prUrl: "u" }, timestamp: "2026-04-20T09:00:00Z" }
    const s1 = reduce(emptyState(), "run", action, "shipped", "kody", {
      jobKey: "instant:run:42",
      jobId: "gh-77-1",
      flavor: "instant",
      target: 42,
      agent: "kody",
      runUrl: "https://ci/run/77",
    })
    const s2 = parseStateComment(renderStateComment(s1))

    expect(s2.jobs["instant:run:42"]?.status).toBe("succeeded")
    expect(s2.jobs["instant:run:42"]?.agentRuns.at(-1)?.id).toBe("gh-77-1")
  })

  it("renders canonical implementation fields without old state keys", () => {
    const action: Action = { type: "RUN_COMPLETED", payload: {}, timestamp: "2026-04-20T09:00:00Z" }
    const state = reduce(emptyState(), "run", action, "shipped", "kody", {
      jobKey: "instant:run:42",
      jobId: "gh-77-1",
      flavor: "instant",
      implementation: "run",
    })

    const body = renderStateComment(state)
    expect(body).toContain("currentImplementation")
    expect(body).toContain("implementations")
    expect(body).toContain('"implementation": "run"')
  })

  it("parses older state comments that do not have jobs", () => {
    const body = `${STATE_BEGIN}\n\n\`\`\`json\n${JSON.stringify({
      schemaVersion: 1,
      core: emptyState().core,
      artifacts: {},
      implementations: {},
      history: [],
    })}\n\`\`\`\n\n${STATE_END}`

    expect(parseStateComment(body).jobs).toEqual({})
  })

  it("renders a human section with attempts + PR URL", () => {
    const s = reduce(emptyState(), "build", {
      type: "RUN_COMPLETED",
      payload: { prUrl: "https://ex/pull/42" },
      timestamp: "t",
    })
    s.core.prUrl = "https://ex/pull/42"
    const body = renderStateComment(s)
    expect(body).toMatch(/## .*kody task state/)
    expect(body).toMatch(/\*\*Attempts:\*\* build:1/)
    expect(body).toMatch(/\*\*PR:\*\* https:\/\/ex\/pull\/42/)
  })

  it("renders a human jobs summary and jobs section", () => {
    const s = reduce(
      emptyState(),
      "run",
      {
        type: "RUN_COMPLETED",
        payload: {},
        timestamp: "t",
      },
      "shipped",
      null,
      {
        jobKey: "instant:run:42",
        jobId: "gh-1",
        flavor: "instant",
      },
    )
    const body = renderStateComment(s)
    expect(body).toContain("**Jobs:** 1/1 complete")
    expect(body).toContain("### Jobs")
    expect(body).toContain("`instant:run:42` **run** → `succeeded` (1 runs)")
  })

  it("puts the title at the top and collapses the JSON in <details>", () => {
    const s = reduce(emptyState(), "build", {
      type: "RUN_COMPLETED",
      payload: {},
      timestamp: "t",
    })
    const body = renderStateComment(s)
    const titleIdx = body.indexOf("kody task state")
    const beginIdx = body.indexOf(STATE_BEGIN)
    expect(titleIdx).toBeGreaterThanOrEqual(0)
    expect(beginIdx).toBeGreaterThan(titleIdx) // title precedes machine block
    expect(body).toContain("<details>")
    expect(body).toContain("<summary>Raw state (JSON)</summary>")
    expect(body).toContain("</details>")
    // Round-trips through parseStateComment despite the wrapping markup.
    const reloaded = parseStateComment(body)
    expect(reloaded.core.lastOutcome?.type).toBe("RUN_COMPLETED")
  })
})
