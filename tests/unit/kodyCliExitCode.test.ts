import { describe, expect, it } from "vitest"
import { normalizeJobExitCode } from "../../src/kody-cli.js"

describe("normalizeJobExitCode", () => {
  it("preserves a blocked workflow exit code", () => {
    expect(normalizeJobExitCode(64)).toBe(64)
  })

  it("maps an invalid process exit code to the wrapper failure code", () => {
    expect(normalizeJobExitCode(300)).toBe(99)
  })
})
