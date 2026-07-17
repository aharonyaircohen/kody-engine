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

  it("appends goal run events to the daily log stream", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )
    await backend.appendDailyLog("acme/app", "events", "2026-07-17", { goalId: "g1", event: "tick" })
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.dailyLogs.append, {
      tenantId: "acme/app",
      stream: "events",
      date: "2026-07-17",
      entry: { goalId: "g1", event: "tick" },
    })
  })

  it("stores run summaries and ordered run evidence in their dedicated aggregates", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )
    await backend.saveAgencyRun(
      "acme/app",
      "goal:g1:run-1",
      "goal",
      "g1",
      { status: "running" },
      "2026-07-17T10:00:00.000Z",
    )
    await backend.appendRunEvent(
      "acme/app",
      "goal:g1:run-1",
      "g1",
      { event: "goal.tick.dispatch" },
      "2026-07-17T10:00:00.000Z",
    )

    expect(transport.mutation).toHaveBeenCalledWith(anyApi.agencyRuns.save, {
      tenantId: "acme/app",
      runId: "goal:g1:run-1",
      subjectType: "goal",
      subjectId: "g1",
      run: { status: "running" },
      updatedAt: "2026-07-17T10:00:00.000Z",
    })
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.runEvents.append, {
      tenantId: "acme/app",
      runId: "goal:g1:run-1",
      goalId: "g1",
      event: { event: "goal.tick.dispatch" },
      time: "2026-07-17T10:00:00.000Z",
    })
  })

  it("stores reports with a stable slug and run id", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )
    await backend.saveReport("acme/app", "release", "run-1", "Release", "# Release", { owner: "kody" }, "now")
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.reports.save, {
      tenantId: "acme/app",
      slug: "release",
      runId: "run-1",
      title: "Release",
      body: "# Release",
      meta: { owner: "kody" },
      updatedAt: "now",
    })
  })

  it("reads and writes company intents through the intent aggregate", async () => {
    const transport = client()
    const backend = createStateBackendFromEnv(
      { CONVEX_URL: "https://example.convex.cloud", KODY_SERVICE_KEY: "secret" },
      transport,
    )
    await backend.listIntents("acme/app")
    await backend.getIntent("acme/app", "release-confidence")
    await backend.saveIntent("acme/app", "release-confidence", { id: "release-confidence" }, "now")
    await backend.appendIntentDecision("acme/app", "release-confidence", { action: "pause", at: "now" })
    expect(transport.query).toHaveBeenCalledWith(anyApi.intents.list, { tenantId: "acme/app" })
    expect(transport.query).toHaveBeenCalledWith(anyApi.intents.get, {
      tenantId: "acme/app",
      intentId: "release-confidence",
    })
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.intents.save, expect.objectContaining({
      tenantId: "acme/app",
      intentId: "release-confidence",
      updatedAt: "now",
    }))
    expect(transport.mutation).toHaveBeenCalledWith(anyApi.intents.appendDecision, {
      tenantId: "acme/app",
      intentId: "release-confidence",
      decision: { action: "pause", at: "now" },
    })
  })
})
