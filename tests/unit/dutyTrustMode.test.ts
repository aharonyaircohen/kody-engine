import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the gh() shell wrapper so we exercise the reader's fail-safe logic
// without a real GitHub round-trip.
vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { isDispatchGated, parseDutyTrustMode, readDutyTrustMode } from "../../src/dutyMcp.js"
import { gh } from "../../src/issue.js"

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("parseDutyTrustMode (pure)", () => {
  it("returns auto only when the duty's mode is exactly auto", () => {
    const json = JSON.stringify({ duties: { qa: { mode: "auto" }, "qa-verify": { mode: "ask" } } })
    expect(parseDutyTrustMode(json, "qa")).toBe("auto")
    expect(parseDutyTrustMode(json, "qa-verify")).toBe("ask")
  })

  it("fails safe to ask on unknown duty, missing duties, or junk", () => {
    expect(parseDutyTrustMode(JSON.stringify({ duties: {} }), "qa")).toBe("ask")
    expect(parseDutyTrustMode(JSON.stringify({}), "qa")).toBe("ask")
    expect(parseDutyTrustMode("not json", "qa")).toBe("ask")
    expect(parseDutyTrustMode("", "qa")).toBe("ask")
  })
})

describe("readDutyTrustMode (gh-backed)", () => {
  it("reads + decodes the kody-state file and returns the mode", () => {
    vi.mocked(gh).mockReturnValue(b64(JSON.stringify({ duties: { qa: { mode: "auto" } } })))
    expect(readDutyTrustMode("o/r", "qa")).toBe("auto")
    const call = vi.mocked(gh).mock.calls[0]![0] as string[]
    expect(call.join(" ")).toContain(".kody/state/trust.json?ref=kody-state")
  })

  it("returns ask when the slug is absent (no gh call)", () => {
    expect(readDutyTrustMode("o/r", undefined)).toBe("ask")
    expect(gh).not.toHaveBeenCalled()
  })

  it("fails safe to ask when the file is missing (gh throws)", () => {
    vi.mocked(gh).mockImplementation(() => {
      throw new Error("HTTP 404: Not Found")
    })
    expect(readDutyTrustMode("o/r", "qa")).toBe("ask")
  })
})

describe("isDispatchGated", () => {
  it("auto duty: nothing gated", () => {
    expect(isDispatchGated("run", "auto")).toBe(false)
    expect(isDispatchGated("qa-goal", "auto")).toBe(false)
  })
  it("ask duty: actions gated, read-only reviews exempt", () => {
    expect(isDispatchGated("run", "ask")).toBe(true)
    expect(isDispatchGated("qa-goal", "ask")).toBe(true)
    expect(isDispatchGated("merge", "ask")).toBe(true)
    expect(isDispatchGated("qa-engineer", "ask")).toBe(false) // read-only check
    expect(isDispatchGated("ui-review", "ask")).toBe(false) // read-only check
  })
})
