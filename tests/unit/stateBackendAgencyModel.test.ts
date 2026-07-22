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

  it("appends and reads Run outputs through the Agency Model", async () => {
    const query = vi.fn().mockResolvedValue([{ recordId: "output-1" }])
    const mutation = vi.fn()
    const backend = createStateBackendFromEnv({}, { query, mutation })
    const output = { kind: "evidence", runId: "run-1" }

    await backend.appendAgencyOutput("acme/widgets", "output-1", 1, output)
    await expect(backend.listAgencyOutputs("acme/widgets", "run-1")).resolves.toEqual([{ recordId: "output-1" }])

    expect(mutation.mock.calls[0]?.[1]).toMatchObject({
      tenantId: "acme/widgets",
      envelope: { schemaVersion: 1, recordId: "output-1", data: output },
    })
  })
})
