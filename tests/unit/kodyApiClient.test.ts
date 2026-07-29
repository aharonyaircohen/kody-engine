import { afterEach, describe, expect, it, vi } from "vitest"
import {
  readRuntimeSecretFromKody,
  resetKodyApiTokenForTests,
  resolveKodyApiUrl,
} from "../../src/kody-api-client.js"

afterEach(() => {
  vi.unstubAllGlobals()
  resetKodyApiTokenForTests()
})

describe("resolveKodyApiUrl", () => {
  it("uses the Engine-owned production control plane by default", () => {
    expect(resolveKodyApiUrl({})).toBe("https://kody-dashboard-aguy.vercel.app")
  })

  it("keeps an explicit deployment override and removes its trailing slash", () => {
    expect(resolveKodyApiUrl({ KODY_API_URL: "https://control.example.test/" })).toBe(
      "https://control.example.test",
    )
  })
})

describe("Kody API client", () => {
  it("honors the Dashboard URL supplied by the workflow", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "signed-oidc-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "secret-value" }), {
          status: 200,
        }),
      )
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      readRuntimeSecretFromKody("MODEL_API_KEY", {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
        DASHBOARD_URL: "https://current-dashboard.example/",
      }),
    ).resolves.toBe("secret-value")

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://current-dashboard.example/api/kody/engine/secret")
  })
})
