import { describe, expect, it, vi } from "vitest"
import { anyApi } from "convex/server"
import { createStateBackendFromEnv, type StateBackendClient } from "../../src/state-backend.js"

function client(): StateBackendClient {
  return {
    query: vi.fn().mockResolvedValue({
      tenantId: "acme/app",
      taskKey: "issues/42",
      kind: "context",
      doc: { target: 42 },
      updatedAt: "2026-07-17T00:00:00.000Z",
    }),
    mutation: vi.fn().mockResolvedValue(undefined),
  }
}

describe("state backend", () => {
  it("fails closed when backend credentials are incomplete", () => {
    expect(() => createStateBackendFromEnv({ CONVEX_URL: "https://example.convex.cloud" })).toThrow(
      "CONVEX_URL and KODY_SERVICE_KEY are required",
    )
  })

  it("uses the tenant, task key, and kind as the durable address", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )

    await expect(backend.get("acme/app", "issues/42", "context")).resolves.toMatchObject({
      doc: { target: 42 },
    })
    expect(transport.query).toHaveBeenCalledWith(anyApi.taskState.get, {
      tenantId: "acme/app",
      taskKey: "issues/42",
      kind: "context",
    })
  })

  it("passes the previous timestamp for optimistic concurrency", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )

    await backend.save("acme/app", "issues/42", "state", { status: "done" }, "2026-07-17T00:00:00.000Z")
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.taskState.save, expect.objectContaining({
      tenantId: "acme/app",
      taskKey: "issues/42",
      kind: "state",
      doc: { status: "done" },
      expectedUpdatedAt: "2026-07-17T00:00:00.000Z",
    }))
  })

  it("supports bounded repository-document reads and guarded writes", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )

    await backend.getRepoDoc("acme/app", "memory:preferences")
    await backend.listRepoDocs("acme/app", "memory:")
    await backend.saveRepoDoc("acme/app", "memory:preferences", { content: "plain" }, "old")

    expect(transport.query).toHaveBeenCalledWith(anyApi.repoDocs.get, {
      tenantId: "acme/app",
      kind: "memory:preferences",
    })
    expect(transport.query).toHaveBeenCalledWith(anyApi.repoDocs.listByPrefix, {
      tenantId: "acme/app",
      prefix: "memory:",
    })
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.repoDocs.save, expect.objectContaining({
      tenantId: "acme/app",
      kind: "memory:preferences",
      expectedUpdatedAt: "old",
    }))
  })
})
