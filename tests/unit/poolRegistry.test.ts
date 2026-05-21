import { describe, expect, it } from "vitest"

import { PoolRegistry } from "../../src/pool/registry.js"
import type { FlyGuest } from "../../src/pool/fly.js"

const BASE = {
  min: 2,
  image: "registry.fly.io/kody-runner:latest",
  region: "fra",
  guest: { cpu_kind: "performance", cpus: 1, memory_mb: 2048 } as FlyGuest,
  runnerApiKey: "runner-key",
  litellmUrl: "http://kody-litellm.internal:4000",
  port: 8080,
  healthTimeoutMs: 5_000,
  app: "kody-runner",
}

const REQ = { jobId: "j1", repo: "owner/name", issueNumber: 7 }

describe("PoolRegistry", () => {
  it("returns ok:false (no pool) when the repo has no FLY_API_TOKEN in its vault", async () => {
    const registry = new PoolRegistry({
      githubToken: "ghp_op",
      masterKey: Buffer.alloc(32),
      base: BASE,
      resolveFlyToken: async () => null, // repo not Fly-configured
    })
    const res = await registry.claim("owner", "name", REQ)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/FLY_API_TOKEN/)
    expect(registry.activeRepos()).toEqual([]) // no pool created
  })

  it("returns ok:false when the vault read throws", async () => {
    const registry = new PoolRegistry({
      githubToken: "ghp_op",
      masterKey: Buffer.alloc(32),
      base: BASE,
      resolveFlyToken: async () => {
        throw new Error("github 403")
      },
    })
    const res = await registry.claim("owner", "name", REQ)
    expect(res.ok).toBe(false)
  })

  it("status is null for a repo with no pool yet", () => {
    const registry = new PoolRegistry({
      githubToken: "ghp_op",
      masterKey: Buffer.alloc(32),
      base: BASE,
      resolveFlyToken: async () => null,
    })
    expect(registry.status("owner", "name")).toBeNull()
  })
})
