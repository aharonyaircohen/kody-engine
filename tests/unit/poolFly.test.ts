import { describe, expect, it } from "vitest"

import { FlyClient } from "../../src/pool/fly.js"

describe("FlyClient.createPooled", () => {
  it("omits KODY_LITELLM_URL when no shared proxy is configured", async () => {
    const calls: unknown[] = []
    const fly = new FlyClient({
      token: "fly-token",
      app: "kody-runner",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ id: "m1" }), { status: 200 })
      }) as typeof fetch,
    })

    await fly.createPooled({
      image: "registry.fly.io/kody-runner:latest",
      region: "fra",
      guest: { cpu_kind: "performance", cpus: 1, memory_mb: 2048 },
      runnerApiKey: "runner-key",
      repoTag: "o/r",
      port: 8080,
    })

    const body = calls[0] as { config: { env: Record<string, string> } }
    expect(body.config.env).toEqual({
      RUNNER_API_KEY: "runner-key",
      PORT: "8080",
    })
    expect(body.config.env).not.toHaveProperty("KODY_LITELLM_URL")
  })

  it("passes KODY_LITELLM_URL only when explicitly configured", async () => {
    const calls: unknown[] = []
    const fly = new FlyClient({
      token: "fly-token",
      app: "kody-runner",
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ id: "m1" }), { status: 200 })
      }) as typeof fetch,
    })

    await fly.createPooled({
      image: "registry.fly.io/kody-runner:latest",
      region: "fra",
      guest: { cpu_kind: "performance", cpus: 1, memory_mb: 2048 },
      runnerApiKey: "runner-key",
      litellmUrl: " http://pool.internal:4000 ",
      repoTag: "o/r",
      port: 8080,
    })

    const body = calls[0] as { config: { env: Record<string, string> } }
    expect(body.config.env.KODY_LITELLM_URL).toBe("http://pool.internal:4000")
  })
})
