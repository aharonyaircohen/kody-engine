import { describe, expect, it } from "vitest"
import { loadConfig } from "../../src/config.js"

describe("Test Health configuration", () => {
  it("configures a repository-owned coverage gate", () => {
    const config = loadConfig(process.cwd())

    expect(config.quality.coverage).toBe("pnpm tsx scripts/check-coverage-floor.ts")
  })
})
