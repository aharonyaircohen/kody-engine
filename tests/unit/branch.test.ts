import { describe, expect, it } from "vitest"
import { deriveBranchName } from "../../src/branch.js"
import { resolveBaseOverride } from "../../src/scripts/runFlow.js"

describe("deriveBranchName", () => {
  it("uses the slugified title", () => {
    expect(deriveBranchName(42, "Add revenue metrics")).toBe("42-add-revenue-metrics")
  })

  it("never returns a bare number when the slug is empty (non-ASCII title)", () => {
    // Regression: a Hebrew-only title slugged to "" → branch "1678" →
    // `git rev-parse --verify 1678` resolved an object → detached HEAD →
    // `git push origin 1678` failed "cannot be resolved to branch".
    const branch = deriveBranchName(1678, "הוספת המלצה לשיעור עוקב בדף סיום שיעור")
    expect(branch).toBe("1678-task")
    expect(branch).not.toMatch(/^\d+$/)
  })

  it("emoji/punctuation-only title also falls back to <n>-task", () => {
    expect(deriveBranchName(7, "🚀🔥 — ✅")).toBe("7-task")
  })
})

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
