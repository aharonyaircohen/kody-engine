import { afterEach, describe, expect, it, vi } from "vitest"
import type { LoopDefinition } from "../../src/loopDefinitions.js"
import {
  assertLoopDispatchesSucceeded,
  dispatchLoopsWith,
  dueSlot,
  loopDispatchSlot,
  loopRunId,
  mergeLoopDefinitions,
  selectRunnableLoops,
} from "../../src/scripts/dispatchLoops.js"

const loop: LoopDefinition = {
  id: "daily-check",
  enabled: true,
  trigger: { type: "schedule", every: "15m" },
  target: { kind: "workflow", id: "quality" },
  input: {},
}

afterEach(() => {
  vi.useRealTimers()
})

describe("dueSlot", () => {
  it("creates one stable schedule slot", () => {
    expect(dueSlot(loop, new Date("2026-07-25T09:07:00.000Z"))).toBe("2026-07-25T09:00:00.000Z")
    expect(dueSlot(loop, new Date("2026-07-25T09:14:59.000Z"))).toBe("2026-07-25T09:00:00.000Z")
  })

  it("ignores disabled and non-scheduled Loops", () => {
    expect(dueSlot({ ...loop, enabled: false }, new Date())).toBeNull()
    expect(dueSlot({ ...loop, trigger: { type: "manual" } }, new Date())).toBeNull()
  })

  it("keeps preferred-time Loops due across the scheduler wake window", () => {
    const preferred: LoopDefinition = {
      ...loop,
      trigger: { type: "schedule", every: "1d", at: { time: "12:00", timezone: "Asia/Jerusalem" } },
    }
    expect(dueSlot(preferred, new Date("2026-07-25T09:03:00.000Z"))).toBe("2026-07-25T12:00[Asia/Jerusalem]")
    expect(dueSlot(preferred, new Date("2026-07-25T09:06:00.000Z"))).toBeNull()
  })
})

describe("loopDispatchSlot", () => {
  it("gives manual runs a unique slot without changing scheduled slots", () => {
    const now = new Date("2026-07-25T09:07:00.000Z")

    expect(loopDispatchSlot(loop, now, false, "ignored")).toBe("2026-07-25T09:00:00.000Z")
    expect(loopDispatchSlot(loop, now, true, "run-123")).toBe("manual:2026-07-25T09:07:00.000Z:run-123")
  })
})

describe("loopRunId", () => {
  it("keeps Todo-derived Loop run ids within the workflow state limit", () => {
    const id = loopRunId(
      "agency-request-build-repository-specific-healthy-ci-from-the-approved-blueprint",
      "fbe4851e-20c3-4f58-b4a3-458ae473a3ea",
    )

    expect(id).toHaveLength(80)
    expect(id).toMatch(
      /^loop-agency-request-build-repository-specif-fbe4851e-20c3-4f58-b4a3-458ae473a3ea$/,
    )
  })
})

describe("selectRunnableLoops", () => {
  it("forces only the requested Loop", () => {
    const other = { ...loop, id: "other" }

    expect(
      selectRunnableLoops([loop, other], new Date("2026-07-25T09:07:00.000Z"), { force: true, loopId: "daily-check" }),
    ).toEqual([loop])
  })

  it("does not silently run every Loop when a requested Loop is missing", () => {
    expect(
      selectRunnableLoops([loop], new Date("2026-07-25T09:07:00.000Z"), { force: true, loopId: "missing" }),
    ).toEqual([])
  })

  it("allows an enabled manual Loop only when it is explicitly forced", () => {
    const manual = { ...loop, trigger: { type: "manual" } as const }

    expect(selectRunnableLoops([manual], new Date(), { force: false })).toEqual([])
    expect(selectRunnableLoops([manual], new Date(), { force: true, loopId: manual.id })).toEqual([manual])
  })
})

describe("mergeLoopDefinitions", () => {
  it("adds Todo-derived runtime Loops without replacing repository Loops", () => {
    const runtime = {
      ...loop,
      id: "agency-request-build-healthy-ci",
      input: { todoSlug: "build-healthy-ci" },
    }

    expect(mergeLoopDefinitions([loop], [runtime, { invalid: true }])).toEqual([runtime, loop])
  })
})

describe("dispatchLoopsWith", () => {
  it("dispatches the live-Agent capability through the generic Loop runtime", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, reason: "agent cycle completed" })
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: true }),
      renewLoopDispatch: vi.fn(),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun: vi.fn(),
    }

    const results = await dispatchLoopsWith({
      loops: [{
        ...loop,
        target: { kind: "capability", id: "live-agent" },
        input: { agent: "operations-agent", intent: "agency" },
      }],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-08-19T08:00:00.000Z"),
      force: true,
      run,
      nonce: () => "agent",
    })

    expect(results).toEqual([
      { loopId: "daily-check", status: "dispatched", reason: "agent cycle completed" },
    ])
    expect(results).toHaveLength(1)
    expect(run).toHaveBeenCalledWith(
      {
        capability: "live-agent",
        cliArgs: { agent: "operations-agent", intent: "agency" },
        flavor: "scheduled",
      },
      expect.any(String),
      "daily-check",
    )
  })

  it("persists the Loop parent and links the target run to it", async () => {
    const createAgencyRun = vi.fn()
    const finishAgencyRun = vi.fn()
    const finishLoopDispatch = vi.fn()
    const run = vi.fn().mockResolvedValue({ exitCode: 0, reason: "workflow completed" })
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: true }),
      renewLoopDispatch: vi.fn(),
      finishLoopDispatch,
      createAgencyRun,
      finishAgencyRun,
    }

    const results = await dispatchLoopsWith({
      loops: [
        {
          ...loop,
          trigger: { type: "schedule", every: "1d" },
          input: { repeat: 2, slowTestMs: 300_000, repair: true },
        },
      ],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:00:00.000Z"),
      force: false,
      run,
      nonce: () => "stable",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "dispatched", reason: "workflow completed" }])
    const parentRunId = createAgencyRun.mock.calls[0]?.[3]?.id
    expect(run).toHaveBeenCalledWith(
      {
        workflow: "quality",
        workflowRunId: parentRunId,
        cliArgs: { repeat: 2, slowTestMs: 300_000, repair: true },
        flavor: "scheduled",
      },
      parentRunId,
      "daily-check",
    )
    expect(createAgencyRun).toHaveBeenCalledWith(
      "acme/widgets",
      "loop",
      "daily-check",
      expect.objectContaining({
        id: parentRunId,
        status: "running",
        target: { kind: "workflow", id: "quality" },
      }),
      "2026-07-29T08:00:00.000Z",
    )
    expect(finishAgencyRun).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({
        id: parentRunId,
        status: "succeeded",
        output: { summary: "workflow completed" },
      }),
      expect.any(String),
    )
    expect(finishLoopDispatch).toHaveBeenCalledWith(
      "acme/widgets",
      "daily-check:2026-07-29T00:00:00.000Z",
      "reservation-stable",
      "dispatched",
      expect.any(String),
      parentRunId,
    )
    expect(backend.reserveLoopDispatch).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({
        leaseUntil: "2026-07-29T08:10:00.000Z",
      }),
    )
  })

  it("renews the reservation while a Loop target is still running", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-29T08:00:00.000Z"))
    let finishRun!: (result: { exitCode: number; reason: string }) => void
    const run = vi.fn(
      () =>
        new Promise<{ exitCode: number; reason: string }>((resolve) => {
          finishRun = resolve
        }),
    )
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: true }),
      renewLoopDispatch: vi.fn().mockResolvedValue(undefined),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun: vi.fn(),
    }

    const pending = dispatchLoopsWith({
      loops: [loop],
      tenantId: "acme/widgets",
      backend,
      now: new Date(),
      force: true,
      run,
      nonce: () => "renewed",
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(backend.renewLoopDispatch).toHaveBeenCalledWith(
      "acme/widgets",
      "daily-check:manual:2026-07-29T08:00:00.000Z:renewed",
      "reservation-renewed",
      "2026-07-29T08:11:00.000Z",
      "2026-07-29T08:01:00.000Z",
    )

    finishRun({ exitCode: 0, reason: "workflow completed" })
    await pending
  })

  it("records a failed Loop run when the target throws", async () => {
    const finishAgencyRun = vi.fn()
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: true }),
      renewLoopDispatch: vi.fn(),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun,
    }

    const results = await dispatchLoopsWith({
      loops: [loop],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:07:00.000Z"),
      force: false,
      run: vi.fn().mockRejectedValue(new Error("target crashed")),
      nonce: () => "failed",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "failed", reason: "target crashed" }])
    expect(finishAgencyRun).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({ status: "failed", error: "target crashed" }),
      expect.any(String),
    )
    expect(backend.finishLoopDispatch).toHaveBeenCalledWith(
      "acme/widgets",
      "daily-check:2026-07-29T08:00:00.000Z",
      "reservation-failed",
      "failed",
      expect.any(String),
      expect.any(String),
    )
  })

  it("does not create a second Run when the schedule slot is already reserved", async () => {
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: false, reason: "duplicate" }),
      renewLoopDispatch: vi.fn(),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun: vi.fn(),
    }
    const run = vi.fn()

    const results = await dispatchLoopsWith({
      loops: [loop],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:07:00.000Z"),
      force: false,
      run,
      nonce: () => "duplicate",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "skipped", reason: "duplicate" }])
    expect(run).not.toHaveBeenCalled()
    expect(backend.createAgencyRun).not.toHaveBeenCalled()
    expect(backend.finishAgencyRun).not.toHaveBeenCalled()
  })

  it("reports capacity refusal as blocked instead of a successful skip", async () => {
    const backend = {
      reserveLoopDispatch: vi.fn().mockResolvedValue({ acquired: false, reason: "concurrency-limit" }),
      renewLoopDispatch: vi.fn(),
      finishLoopDispatch: vi.fn(),
      createAgencyRun: vi.fn(),
      finishAgencyRun: vi.fn(),
    }

    const results = await dispatchLoopsWith({
      loops: [loop],
      tenantId: "acme/widgets",
      backend,
      now: new Date("2026-07-29T08:07:00.000Z"),
      force: true,
      run: vi.fn(),
      nonce: () => "blocked",
    })

    expect(results).toEqual([{ loopId: "daily-check", status: "blocked", reason: "concurrency-limit" }])
    expect(() => assertLoopDispatchesSucceeded(results)).toThrow(
      "Loop dispatch did not run: daily-check: concurrency-limit",
    )
  })
})

describe("assertLoopDispatchesSucceeded", () => {
  it("fails the outer CI run when any Loop target failed", () => {
    expect(() =>
      assertLoopDispatchesSucceeded([{ loopId: "daily-check", status: "failed", reason: "target missing" }]),
    ).toThrow("Loop dispatch did not run: daily-check: target missing")
  })

  it("allows dispatched and idempotently skipped Loops", () => {
    expect(() =>
      assertLoopDispatchesSucceeded([
        { loopId: "daily-check", status: "dispatched", reason: "completed" },
        { loopId: "other", status: "skipped", reason: "duplicate" },
      ]),
    ).not.toThrow()
  })
})
