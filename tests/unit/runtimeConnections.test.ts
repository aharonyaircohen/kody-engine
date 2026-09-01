import { describe, expect, it, vi } from "vitest"
import { resolveRuntimeConnections } from "../../src/scripts/runtimeConnections.js"

const connection = {
  id: "facebook-main",
  name: "Yair Facebook Page",
  provider: "facebook",
  accountType: "page",
  externalId: "123456789",
  credentialRefs: { accessToken: "FACEBOOK_PAGE_ACCESS_TOKEN" },
  status: "connected" as const,
  verifiedAt: "2026-08-31T12:00:00.000Z",
}

describe("runtime Connections", () => {
  it("loads only declared Connections and returns no credential value", async () => {
    const load = vi.fn(async () => connection)
    await expect(resolveRuntimeConnections(["facebook-main"], ["FACEBOOK_PAGE_ACCESS_TOKEN"], load)).resolves.toEqual([
      connection,
    ])
    expect(load).toHaveBeenCalledWith("facebook-main")
    expect(JSON.stringify((await load.mock.results[0]?.value) ?? null)).not.toContain("secret-value")
  })

  it("fails closed for missing, unverified, or non-allowlisted credentials", async () => {
    await expect(
      resolveRuntimeConnections(["missing"], ["FACEBOOK_PAGE_ACCESS_TOKEN"], async () => null),
    ).rejects.toThrow(/not found/i)
    await expect(
      resolveRuntimeConnections(["facebook-main"], ["FACEBOOK_PAGE_ACCESS_TOKEN"], async () => ({
        ...connection,
        status: "needs_attention",
      })),
    ).rejects.toThrow(/not connected/i)
    await expect(resolveRuntimeConnections(["facebook-main"], [], async () => connection)).rejects.toThrow(
      /not allowlisted/i,
    )
  })
})
