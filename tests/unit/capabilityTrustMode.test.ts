import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import {
  isDispatchGated,
  parseCapabilityTrustMode,
  readCapabilityTrustMode,
} from "../../src/capabilityMcp.js"
import { gh } from "../../src/issue.js"

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")
const state = { repo: "o/kody-state", path: "r" }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("parseCapabilityTrustMode (pure)", () => {
  it("returns auto only when capability's mode is exactly auto", () => {
    const json = JSON.stringify({ capabilities: { qa: { mode: "auto" }, "qa-verify": { mode: "ask" } } })
    expect(parseCapabilityTrustMode(json, "qa")).toBe("auto")
    expect(parseCapabilityTrustMode(json, "qa-verify")).toBe("ask")
  })

  it("fails safe to ask on unknown capability, missing capabilities, or junk", () => {
    expect(parseCapabilityTrustMode(JSON.stringify({ capabilities: {} }), "qa")).toBe("ask")
    expect(parseCapabilityTrustMode(JSON.stringify({}), "qa")).toBe("ask")
    expect(parseCapabilityTrustMode("not json", "qa")).toBe("ask")
    expect(parseCapabilityTrustMode("", "qa")).toBe("ask")
  })
})

describe("readCapabilityTrustMode (gh-backed)", () => {
  it("reads + decodes state repo trust file returns mode", () => {
    vi.mocked(gh).mockReturnValue(
      JSON.stringify({
        type: "file",
        encoding: "base64",
        sha: "abc",
        content: b64(JSON.stringify({ capabilities: { qa: { mode: "auto" } } })),
      }),
    )

    expect(readCapabilityTrustMode(state, "o/r", "qa")).toBe("auto")
    const call = vi.mocked(gh).mock.calls[0]![0] as string[]
    expect(call.join(" ")).toContain("/repos/o/kody-state/contents/r/state/trust.json")
  })

  it("returns ask when slug is absent (no gh call)", () => {
    expect(readCapabilityTrustMode(state, "o/r", undefined)).toBe("ask")
    expect(gh).not.toHaveBeenCalled()
  })

  it("fails safe to ask when file is missing", () => {
    vi.mocked(gh).mockImplementation(() => {
      throw new Error("HTTP 404: Not Found")
    })
    expect(readCapabilityTrustMode(state, "o/r", "qa")).toBe("ask")
  })
})

describe("isDispatchGated", () => {
  it("auto capability: nothing gated", () => {
    expect(isDispatchGated("run", "auto")).toBe(false)
    expect(isDispatchGated("qa-goal", "auto")).toBe(false)
  })

  it("ask capability: actions gated, read-only reviews exempt", () => {
    expect(isDispatchGated("run", "ask")).toBe(true)
    expect(isDispatchGated("qa-goal", "ask")).toBe(true)
    expect(isDispatchGated("merge", "ask")).toBe(true)
    expect(isDispatchGated("qa-engineer", "ask")).toBe(false)
    expect(isDispatchGated("ui-review", "ask")).toBe(false)
  })
})
