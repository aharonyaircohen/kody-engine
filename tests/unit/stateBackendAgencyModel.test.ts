import { getFunctionName } from "convex/server"
import { describe, expect, it, vi } from "vitest"
import { createStateBackendFromEnv } from "../../src/state-backend.js"

describe("Agency Model state backend", () => {
  it("reads definitions and mutable state through distinct operations", async () => {
    const query = vi.fn(async (fn) => {
      if (getFunctionName(fn) === "agencyModel:listDefinitions") return [{ recordId: "goal-1" }]
      if (getFunctionName(fn) === "agencyModel:getState") return { definitionId: "goal-1" }
      return null
    })
    const mutation = vi.fn()
    const backend = createStateBackendFromEnv({}, { query, mutation })

    await expect(backend.listAgencyDefinitions("acme/widgets")).resolves.toEqual([{ recordId: "goal-1" }])
    await expect(backend.getAgencyState("acme/widgets", "goal-1")).resolves.toEqual({ definitionId: "goal-1" })

    expect(query.mock.calls.map(([fn]) => getFunctionName(fn))).toEqual([
      "agencyModel:listDefinitions",
      "agencyModel:getState",
    ])
  })

  it("writes state without adding persistence metadata to domain data", async () => {
    const mutation = vi.fn()
    const backend = createStateBackendFromEnv({}, { query: vi.fn(), mutation })
    const data = { definitionId: "goal-1", lifecycle: "active", progress: 0 }

    await backend.putAgencyState("acme/widgets", "goal-1", "goal", 1, data, "2026-07-22T00:00:00.000Z")

    expect(mutation).toHaveBeenCalledOnce()
    expect(mutation.mock.calls[0]?.[1]).toEqual({
      tenantId: "acme/widgets",
      definitionId: "goal-1",
      kind: "goal",
      schemaVersion: 1,
      data,
      updatedAt: "2026-07-22T00:00:00.000Z",
    })
    expect(data).not.toHaveProperty("version")
  })
})
