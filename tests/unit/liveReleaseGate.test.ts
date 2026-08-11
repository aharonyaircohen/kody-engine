import { describe, expect, it, vi } from "vitest"
import { runLiveReleaseGate } from "../../src/liveReleaseGate.js"

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("live release gate", () => {
  it("requires one Store workflow to pass in GitHub and appear in Dashboard state", async () => {
    let githubLists = 0
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("api.github.com") && url.includes("/runs")) {
        githubLists += 1
        return response({
          workflow_runs:
            githubLists === 1
              ? [{ id: 10, status: "completed", conclusion: "success", html_url: "https://github/runs/10" }]
              : [{ id: 11, status: "completed", conclusion: "success", html_url: "https://github/runs/11" }],
        })
      }
      if (url.endsWith("/api/kody/store-catalog/import") && init?.method === "POST") {
        return response({ imported: true, status: "imported" })
      }
      if (url.endsWith("/api/kody/company/workflows") && !init?.method) {
        return response({
          workflows: [
            {
              id: "engine-release-gate",
              source: "store",
              runnable: true,
              automation: { eligible: true },
            },
          ],
        })
      }
      if (url.endsWith("/api/kody/company/workflows/engine-release-gate/run")) {
        return response({ ok: true, workflow: "engine-release-gate", runId: "request-1" })
      }
      if (url.includes("/company/workflows/engine-release-gate/runs?")) {
        return response({ run: { runId: "request-1", state: { status: "done" } } })
      }
      if (url.includes("/api/kody/agency-runs?")) {
        return response({
          runs: [
            {
              id: "workflow:engine-release-gate:request-1",
              targetId: "engine-release-gate",
              status: "success",
            },
          ],
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await runLiveReleaseGate(
      {
        dashboardUrl: "https://dashboard.example",
        owner: "acme",
        repo: "tester",
        token: "secret",
        workflowId: "engine-release-gate",
        timeoutMs: 1_000,
        pollMs: 1,
      },
      { fetch, sleep: async () => undefined },
    )

    expect(result).toMatchObject({
      runId: "request-1",
      githubRunId: 11,
      githubRunUrl: "https://github/runs/11",
      agencyRunId: "workflow:engine-release-gate:request-1",
    })
    expect(fetch).toHaveBeenCalledWith(
      "https://dashboard.example/api/kody/store-catalog/import",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "workflow", slug: "engine-release-gate" }),
      }),
    )
  })

  it("fails when GitHub finishes the dispatched run unsuccessfully", async () => {
    let githubLists = 0
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com") && url.includes("/runs")) {
        githubLists += 1
        return response({
          workflow_runs:
            githubLists === 1
              ? []
              : [{ id: 12, status: "completed", conclusion: "failure", html_url: "https://github/runs/12" }],
        })
      }
      if (url.endsWith("/api/kody/store-catalog/import")) return response({ status: "already_local" })
      if (url.endsWith("/api/kody/company/workflows")) {
        return response({
          workflows: [{ id: "engine-release-gate", source: "store", runnable: true, automation: { eligible: true } }],
        })
      }
      if (url.endsWith("/run")) return response({ runId: "request-2" })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(
      runLiveReleaseGate(
        {
          dashboardUrl: "https://dashboard.example",
          owner: "acme",
          repo: "tester",
          token: "secret",
          workflowId: "engine-release-gate",
          timeoutMs: 1_000,
          pollMs: 1,
        },
        { fetch, sleep: async () => undefined },
      ),
    ).rejects.toThrow(/GitHub run 12 failed/)
  })
})
