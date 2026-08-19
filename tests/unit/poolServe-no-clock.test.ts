import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = readFileSync(resolve("src/servers/pool-serve.ts"), "utf8")

describe("pool server scheduling ownership", () => {
  it("does not run its own automatic Loop clock", () => {
    expect(source).not.toContain("runAgencyLoopTick")
    expect(source).not.toContain("POOL_LOOP_TICK")
    expect(source).not.toContain("POOL_CAPABILITY_TICK")
  })

  it("keeps the explicit authenticated claim endpoint", () => {
    expect(source).toContain('url.pathname === "/pool/claim"')
    expect(source).toContain("bearerOk")
  })
})
