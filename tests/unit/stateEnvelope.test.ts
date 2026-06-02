import { describe, expect, it } from "vitest"
import { extractFencedBlock, extractNextStateFromText, isPartialEnvelope } from "../../src/scripts/stateEnvelope.js"

function fenced(label: string, body: string): string {
  return [`\`\`\`${label}`, body, "```"].join("\n")
}

describe("extractFencedBlock", () => {
  it("returns the trimmed inner text of a labeled block", () => {
    expect(extractFencedBlock(fenced("kody-x", "  hello  "), "kody-x")).toBe("hello")
  })

  it("returns null when the labeled block is absent", () => {
    expect(extractFencedBlock("no fence here", "kody-x")).toBeNull()
    // A differently-labeled block is not a match.
    expect(extractFencedBlock(fenced("other", "x"), "kody-x")).toBeNull()
  })

  it('distinguishes an empty block ("") from a missing one (null)', () => {
    expect(extractFencedBlock(fenced("kody-x", ""), "kody-x")).toBe("")
  })

  it("matches labels containing regex-special characters literally", () => {
    expect(extractFencedBlock(fenced("a.b+c", "v"), "a.b+c")).toBe("v")
  })
})

describe("isPartialEnvelope", () => {
  it("accepts a well-formed partial envelope", () => {
    expect(isPartialEnvelope({ cursor: "c", data: {}, done: false })).toBe(true)
  })

  it("rejects empty cursor, array data, and non-objects", () => {
    expect(isPartialEnvelope({ cursor: "", data: {}, done: false })).toBe(false)
    expect(isPartialEnvelope({ cursor: "c", data: [], done: false })).toBe(false)
    expect(isPartialEnvelope(null)).toBe(false)
    expect(isPartialEnvelope("x")).toBe(false)
  })
})

describe("extractNextStateFromText", () => {
  it("builds an envelope with rev bumped off prevRev", () => {
    const body = JSON.stringify({ cursor: "step", data: { n: 1 }, done: true })
    const r = extractNextStateFromText(fenced("kody-x", body), "kody-x", 4)
    expect(r.envelope).toEqual({ version: 1, rev: 5, cursor: "step", data: { n: 1 }, done: true })
  })

  it("reports a missing-block error", () => {
    expect(extractNextStateFromText("nope", "kody-x", 0).error).toMatch(/missing `kody-x`/)
  })

  it("reports JSON and shape errors distinctly", () => {
    expect(extractNextStateFromText(fenced("kody-x", "{bad"), "kody-x", 0).error).toMatch(/JSON parse error/)
    expect(
      extractNextStateFromText(fenced("kody-x", JSON.stringify({ cursor: "", data: {}, done: false })), "kody-x", 0)
        .error,
    ).toMatch(/string `cursor`/)
  })
})
