import { afterEach, describe, expect, it, vi } from "vitest"

import { notifyWorkflowCompleted } from "../../src/kody-api-client.js"

describe("notifyWorkflowCompleted", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("posts the terminal workflow result with GitHub OIDC identity", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    const env = {
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      KODY_API_URL: "https://dashboard.example",
    } as NodeJS.ProcessEnv

    await notifyWorkflowCompleted(
      {
        workflowId: "ci-repair",
        runId: "run-7",
        status: "success",
        output: {
          pr: 3947,
          headSha: "abcdef1234567",
          verdict: "pass",
        },
      },
      env,
    )

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://dashboard.example/api/kody/engine/workflow-completed",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          workflowId: "ci-repair",
          runId: "run-7",
          status: "success",
          output: {
            pr: 3947,
            headSha: "abcdef1234567",
            verdict: "pass",
          },
        }),
      }),
    )
  })
})
