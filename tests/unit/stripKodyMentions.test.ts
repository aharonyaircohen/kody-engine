import { describe, expect, it } from "vitest"
import { stripKodyMentions } from "../../src/issue.js"

describe("stripKodyMentions", () => {
  const ZWSP = "​"

  it("neutralizes a bare @kody mention", () => {
    expect(stripKodyMentions("@kody run")).toBe(`@${ZWSP}kody run`)
  })

  it("neutralizes @kody inside a markdown code span", () => {
    expect(stripKodyMentions("see `@kody plan`")).toBe(`see \`@${ZWSP}kody plan\``)
  })

  it("is case-insensitive on the `kody` token", () => {
    expect(stripKodyMentions("@Kody run")).toBe(`@${ZWSP}Kody run`)
    expect(stripKodyMentions("@KODY run")).toBe(`@${ZWSP}KODY run`)
  })

  it("catches every occurrence, not just the first", () => {
    const input = "do not post @kody run or @kody review"
    const expected = `do not post @${ZWSP}kody run or @${ZWSP}kody review`
    expect(stripKodyMentions(input)).toBe(expected)
  })

  it("leaves non-kody mentions alone but still neutralizes @kody-bot (which GHA's contains() would match)", () => {
    expect(stripKodyMentions("@someoneElse and @kody-bot")).toBe(`@someoneElse and @${ZWSP}kody-bot`)
  })

  it("leaves unrelated text untouched", () => {
    const plain = "This is a body with no mentions."
    expect(stripKodyMentions(plain)).toBe(plain)
  })

  it("is idempotent — a second pass is a no-op", () => {
    const once = stripKodyMentions("@kody ship it")
    expect(stripKodyMentions(once)).toBe(once)
  })
})
