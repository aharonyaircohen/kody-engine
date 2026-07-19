import { describe, expect, it } from "vitest"
import { resolveBrainDriver } from "../../src/chat/runtime-drivers.js"

describe("resolveBrainDriver", () => {
  it("selects the Codex app-server adapter for the Codex runtime command", () => {
    expect(resolveBrainDriver("codex app-server")).toBe("codex-app-server")
  })

  it("keeps the native driver for the native runtime", () => {
    expect(resolveBrainDriver("native")).toBe("native")
  })

  it("rejects an unknown runtime instead of silently using another model", () => {
    expect(() => resolveBrainDriver("some-other-runtime")).toThrow("Unsupported Brain runtime")
  })
})
