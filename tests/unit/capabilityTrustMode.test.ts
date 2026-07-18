import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { isDispatchGated, parseCapabilityTrustMode, readCapabilityTrustMode } from "../../src/capabilityMcp.js"
import { gh } from "../../src/issue.js"
import { parseTrustModeOverride, readTrustModeOverride } from "../../src/trustPolicy.js"

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

describe("parseTrustModeOverride (pure)", () => {
  it("reads managed subject trust from subjects while preserving missing as no override", () => {
    const json = JSON.stringify({
      capabilities: { qa: { mode: "auto" } },
      subjects: {
        "loop:daily-web-release-loop": { mode: "auto" },
        "goal:web-release": { mode: "ask" },
      },
    })

    expect(parseTrustModeOverride(json, { kind: "capability", id: "qa" })).toBe("auto")
    expect(parseTrustModeOverride(json, { kind: "loop", id: "daily-web-release-loop" })).toBe("auto")
    expect(parseTrustModeOverride(json, { kind: "goal", id: "web-release" })).toBe("ask")
    expect(parseTrustModeOverride(json, { kind: "goal", id: "missing" })).toBeNull()
    expect(parseTrustModeOverride("not json", { kind: "goal", id: "web-release" })).toBeNull()
  })
})

describe("neverAuto pin", () => {
  it("forces ask even when earned mode is auto, for capabilities and subjects", () => {
    const json = JSON.stringify({
      capabilities: { qa: { mode: "auto", neverAuto: true } },
      subjects: { "workflow:web-release": { mode: "auto", neverAuto: true } },
    })

    expect(parseCapabilityTrustMode(json, "qa")).toBe("ask")
    expect(parseTrustModeOverride(json, { kind: "workflow", id: "web-release" })).toBe("ask")
  })

  it("does not affect entries without the flag", () => {
    const json = JSON.stringify({ capabilities: { qa: { mode: "auto", neverAuto: false } } })
    expect(parseCapabilityTrustMode(json, "qa")).toBe("auto")
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

describe("readTrustModeOverride (gh-backed)", () => {
  it("reads managed subject trust from the shared trust file", () => {
    vi.mocked(gh).mockReturnValue(
      JSON.stringify({
        type: "file",
        encoding: "base64",
        sha: "abc",
        content: b64(JSON.stringify({ subjects: { "goal:web-release": { mode: "auto" } } })),
      }),
    )

    expect(readTrustModeOverride(state, "o/r", { kind: "goal", id: "web-release" })).toBe("auto")
    const call = vi.mocked(gh).mock.calls[0]![0] as string[]
    expect(call.join(" ")).toContain("/repos/o/kody-state/contents/r/state/trust.json")
  })
})

describe("isDispatchGated", () => {
  it("does not gate dispatch tools by capability trust", () => {
    expect(isDispatchGated("run", "auto")).toBe(false)
    expect(isDispatchGated("qa-goal", "auto")).toBe(false)
    expect(isDispatchGated("run", "ask")).toBe(false)
    expect(isDispatchGated("qa-goal", "ask")).toBe(false)
    expect(isDispatchGated("merge", "ask")).toBe(false)
    expect(isDispatchGated("qa-engineer", "ask")).toBe(false)
    expect(isDispatchGated("ui-review", "ask")).toBe(false)
  })
})
