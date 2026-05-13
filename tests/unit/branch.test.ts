import { describe, expect, it } from "vitest"
import { resolveBaseOverride } from "../../src/scripts/runFlow.js"

describe("runFlow: resolveBaseOverride", () => {
  // The --base override is the only way a comment can redirect kody onto a
  // non-default branch. dispatchNextTask is the intended caller; it passes
  // either the leaf task branch or the repo's default branch (dev / main /
  // master). We accept any safe ref but reject path-traversal / shell-meta.
  it("accepts kody-task branches (stacked-PR base)", () => {
    expect(resolveBaseOverride("42-add-button")).toBe("42-add-button")
    expect(resolveBaseOverride("1453-fix-typo")).toBe("1453-fix-typo")
  })

  it("accepts ordinary default branches", () => {
    expect(resolveBaseOverride("main")).toBe("main")
    expect(resolveBaseOverride("dev")).toBe("dev")
    expect(resolveBaseOverride("master")).toBe("master")
    expect(resolveBaseOverride("develop")).toBe("develop")
  })

  it("accepts legacy goal branches", () => {
    expect(resolveBaseOverride("goal-add-chat-memory")).toBe("goal-add-chat-memory")
    expect(resolveBaseOverride("goal-x")).toBe("goal-x")
  })

  it("accepts branches with slashes and dots (release/v1.2.3 style)", () => {
    expect(resolveBaseOverride("release/v1.2.3")).toBe("release/v1.2.3")
    expect(resolveBaseOverride("feat/foo")).toBe("feat/foo")
  })

  it("rejects empty / undefined", () => {
    expect(resolveBaseOverride(undefined)).toBeNull()
    expect(resolveBaseOverride("")).toBeNull()
  })

  it("rejects path traversal and unsafe leads", () => {
    expect(resolveBaseOverride("../etc/passwd")).toBeNull()
    expect(resolveBaseOverride("foo/../bar")).toBeNull()
    expect(resolveBaseOverride("-rm")).toBeNull() // leading dash
    expect(resolveBaseOverride("/abs")).toBeNull() // leading slash
    expect(resolveBaseOverride(".hidden")).toBeNull() // leading dot
  })

  it("rejects shell-meta / whitespace / disallowed chars", () => {
    expect(resolveBaseOverride("foo bar")).toBeNull()
    expect(resolveBaseOverride("foo;rm")).toBeNull()
    expect(resolveBaseOverride("foo$bar")).toBeNull()
    expect(resolveBaseOverride("FooUpper")).toBeNull()
  })

  it("rejects values longer than 200 chars", () => {
    expect(resolveBaseOverride("a".repeat(201))).toBeNull()
    expect(resolveBaseOverride("a".repeat(200))).toBe("a".repeat(200))
  })
})
