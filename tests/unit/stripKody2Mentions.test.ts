import { describe, expect, it } from "vitest"
import { stripKody2Mentions } from "../../src/issue.js"

describe("stripKody2Mentions", () => {
  const ZWSP = "​"

  it("neutralizes a bare @kody2 mention", () => {
    expect(stripKody2Mentions("@kody2 run")).toBe(`@${ZWSP}kody2 run`)
  })

  it("neutralizes @kody2 inside a markdown code span", () => {
    expect(stripKody2Mentions("see `@kody2 plan`")).toBe(`see \`@${ZWSP}kody2 plan\``)
  })

  it("is case-insensitive on the `kody2` token", () => {
    expect(stripKody2Mentions("@Kody2 run")).toBe(`@${ZWSP}Kody2 run`)
    expect(stripKody2Mentions("@KODY2 run")).toBe(`@${ZWSP}KODY2 run`)
  })

  it("catches every occurrence, not just the first", () => {
    const input = "do not post @kody2 run or @kody2 review"
    const expected = `do not post @${ZWSP}kody2 run or @${ZWSP}kody2 review`
    expect(stripKody2Mentions(input)).toBe(expected)
  })

  it("leaves non-kody2 mentions alone but still neutralizes @kody2-bot (which GHA's contains() would match)", () => {
    expect(stripKody2Mentions("@someoneElse and @kody2-bot")).toBe(`@someoneElse and @${ZWSP}kody2-bot`)
  })

  it("leaves unrelated text untouched", () => {
    const plain = "This is a body with no mentions."
    expect(stripKody2Mentions(plain)).toBe(plain)
  })

  it("is idempotent — a second pass is a no-op", () => {
    const once = stripKody2Mentions("@kody2 ship it")
    expect(stripKody2Mentions(once)).toBe(once)
  })
})
