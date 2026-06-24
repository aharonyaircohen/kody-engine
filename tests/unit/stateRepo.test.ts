import { describe, expect, it } from "vitest"
import { parseStateRepoSlug } from "../../src/stateRepo.js"

describe("stateRepo: parseStateRepoSlug", () => {
  it("parses canonical full GitHub repository URLs", () => {
    expect(parseStateRepoSlug("https://github.com/o/kody-state")).toEqual({
      owner: "o",
      repo: "kody-state",
    })
  })

  it("parses canonical URLs with .git suffix", () => {
    expect(parseStateRepoSlug("https://github.com/o/kody-state.git")).toEqual({
      owner: "o",
      repo: "kody-state",
    })
  })

  it("keeps legacy owner/repo references readable", () => {
    expect(parseStateRepoSlug("o/kody-state")).toEqual({
      owner: "o",
      repo: "kody-state",
    })
  })

  it("rejects non-GitHub URLs", () => {
    expect(() => parseStateRepoSlug("https://example.com/o/kody-state")).toThrow(/github\.com/)
  })
})
