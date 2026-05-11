import { describe, expect, it } from "vitest"
import { UncommittedChangesError } from "../../src/branch.js"
import { resolveBaseOverride } from "../../src/scripts/runFlow.js"

describe("UncommittedChangesError", () => {
  it("includes branch name in the message + exposes it as a property", () => {
    const err = new UncommittedChangesError("feat-branch")
    expect(err.message).toMatch(/feat-branch/)
    expect(err.name).toBe("UncommittedChangesError")
    expect(err.branch).toBe("feat-branch")
  })
})

describe("runFlow: resolveBaseOverride", () => {
  // The --base override is the only way a comment can redirect kody onto a
  // non-default branch. We allowlist:
  //   - `<digits>-<slug>` — kody-task branch (stacked-PR base, new in 0.4.39)
  //   - `goal-<id>`       — legacy umbrella-era goal branch (still tolerated)
  // anything else (random branches, traversal attempts) is rejected.
  it("accepts a kody-task branch (stacked-PR base)", () => {
    expect(resolveBaseOverride("42-add-button")).toBe("42-add-button")
    expect(resolveBaseOverride("1453-fix-typo")).toBe("1453-fix-typo")
    expect(resolveBaseOverride("1-x")).toBe("1-x")
  })

  it("accepts a well-formed legacy goal branch", () => {
    expect(resolveBaseOverride("goal-add-chat-memory")).toBe("goal-add-chat-memory")
    expect(resolveBaseOverride("goal-x")).toBe("goal-x")
    expect(resolveBaseOverride("goal-1234")).toBe("goal-1234")
  })

  it("rejects empty / undefined", () => {
    expect(resolveBaseOverride(undefined)).toBeNull()
    expect(resolveBaseOverride("")).toBeNull()
  })

  it("rejects arbitrary branches", () => {
    expect(resolveBaseOverride("main")).toBeNull()
    expect(resolveBaseOverride("feat/foo")).toBeNull()
    expect(resolveBaseOverride("release-1.2")).toBeNull()
    expect(resolveBaseOverride("dev")).toBeNull()
  })

  it("rejects values with disallowed characters", () => {
    expect(resolveBaseOverride("42-Bad")).toBeNull() // uppercase
    expect(resolveBaseOverride("42-foo/bar")).toBeNull() // slash
    expect(resolveBaseOverride("42-foo bar")).toBeNull() // space
    expect(resolveBaseOverride("42-")).toBeNull() // trailing dash with empty slug
    expect(resolveBaseOverride("goal-Bad")).toBeNull()
    expect(resolveBaseOverride("goal-")).toBeNull()
  })
})
