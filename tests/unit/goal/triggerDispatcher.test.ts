import { describe, expect, it } from "vitest"
import { decideTrigger } from "../../../src/goal/triggerDispatcher.js"

const loop = {
  id: "refresh-knowledge",
  operationId: "knowledge",
  objective: { desiredState: "Knowledge stays current", requiredEvidence: [], scope: { include: {}, exclude: {} } },
  trigger: { type: "schedule" as const, every: "1h" },
  targetRef: { kind: "workflow" as const, id: "refresh-knowledge-system" },
  reconciliationPolicy: {
    overlap: "skip" as const,
    missed: "coalesce" as const,
    failure: { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 },
  },
}

describe("Trigger dispatcher", () => {
  it("fires a scheduled Loop with a stable idempotency key", () => {
    const decision = decideTrigger({
      definition: loop,
      state: {
        definitionId: loop.id,
        lifecycle: "active",
        health: "healthy",
        failures: 0,
        lastFiredAt: "2026-07-22T10:00:00.000Z",
        updatedAt: "2026-07-22T10:00:00.000Z",
      },
      now: new Date("2026-07-22T11:05:00.000Z"),
    })

    expect(decision).toEqual({
      kind: "fire",
      reason: "scheduled trigger is due",
      scheduledAt: "2026-07-22T11:00:00.000Z",
      idempotencyKey: "refresh-knowledge:schedule:2026-07-22T11:00:00.000Z",
    })
  })

  it("does not fire a paused Loop", () => {
    expect(
      decideTrigger({
        definition: loop,
        state: {
          definitionId: loop.id,
          lifecycle: "paused",
          health: "healthy",
          failures: 0,
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
        now: new Date("2026-07-22T11:05:00.000Z"),
      }),
    ).toMatchObject({ kind: "skip", reason: "loop is paused" })
  })

  it("uses the caller request id for manual idempotency", () => {
    expect(
      decideTrigger({
        definition: { ...loop, trigger: { type: "manual" } },
        state: {
          definitionId: loop.id,
          lifecycle: "active",
          health: "healthy",
          failures: 0,
          updatedAt: "2026-07-22T10:00:00.000Z",
        },
        now: new Date("2026-07-22T11:05:00.000Z"),
        manualRequestId: "operator-42",
      }),
    ).toMatchObject({ kind: "fire", idempotencyKey: "refresh-knowledge:manual:operator-42" })
  })

  it("does not activate a Definition that has no runtime State", () => {
    expect(decideTrigger({ definition: loop, state: null, now: new Date("2026-07-22T11:05:00.000Z") })).toEqual({
      kind: "skip",
      reason: "loop has no runtime state",
    })
  })
})
