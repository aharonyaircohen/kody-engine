import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"

// Mock the issue.ts gh fetch so loadIssueContext's slow path is observable.
const getIssueSpy = vi.fn()
vi.mock("../../src/issue.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/issue.js")>("../../src/issue.js")
  return {
    ...actual,
    getIssue: (n: number, cwd?: string) => {
      getIssueSpy(n, cwd)
      return {
        number: n,
        title: "Fresh fetch",
        body: "fetched body",
        comments: [],
        labels: [],
      }
    },
  }
})

// Mock prompt.loadProjectConventions so loadConventions' slow path is observable.
const loadConventionsSpy = vi.fn()
vi.mock("../../src/prompt.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/prompt.js")>("../../src/prompt.js")
  return {
    ...actual,
    loadProjectConventions: (cwd: string) => {
      loadConventionsSpy(cwd)
      return [{ path: "CLAUDE.md", content: "fresh", truncated: false }]
    },
  }
})

import { loadConventions } from "../../src/scripts/loadConventions.js"
import { loadCoverageRules } from "../../src/scripts/loadCoverageRules.js"
import { loadIssueContext } from "../../src/scripts/loadIssueContext.js"
import { loadMemoryContext } from "../../src/scripts/loadMemoryContext.js"
import { loadPriorArt } from "../../src/scripts/loadPriorArt.js"

const fakeProfile = { name: "test" } as unknown as Profile

function makeCtx(overrides: Partial<Context["data"]> = {}): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp/x",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/claude-sonnet-4-6" },
      testRequirements: [{ pattern: "src/**", requireSibling: "tests/**" }],
    },
    data: { ...overrides },
    output: { exitCode: 0 },
  }
}

describe("Phase 5 fast path: loadIssueContext", () => {
  beforeEach(() => getIssueSpy.mockClear())
  afterEach(() => getIssueSpy.mockClear())

  it("skips the gh fetch when ctx.data.issue is pre-seeded with matching number", async () => {
    const ctx = makeCtx({
      issue: {
        number: 42,
        title: "Preloaded",
        body: "preloaded body",
        comments: [],
        labels: [],
        commentsFormatted: "(none)",
        labelsFormatted: "(no labels)",
      },
    })
    await loadIssueContext(ctx, fakeProfile)
    expect(getIssueSpy).not.toHaveBeenCalled()
    expect((ctx.data.issue as { title: string }).title).toBe("Preloaded")
    expect(ctx.data.commentTargetType).toBe("issue")
    expect(ctx.data.commentTargetNumber).toBe(42)
  })

  it("falls through to fresh fetch when seeded issue is for a different number", async () => {
    const ctx = makeCtx({
      issue: { number: 99, title: "Other", body: "", comments: [], labels: [] },
    })
    await loadIssueContext(ctx, fakeProfile)
    expect(getIssueSpy).toHaveBeenCalledTimes(1)
    expect((ctx.data.issue as { title: string }).title).toBe("Fresh fetch")
  })

  it("fetches fresh when ctx.data.issue is absent", async () => {
    const ctx = makeCtx()
    await loadIssueContext(ctx, fakeProfile)
    expect(getIssueSpy).toHaveBeenCalledTimes(1)
  })
})

describe("Phase 5 fast path: loadConventions", () => {
  beforeEach(() => loadConventionsSpy.mockClear())
  afterEach(() => loadConventionsSpy.mockClear())

  it("skips the filesystem read when ctx.data.conventions is pre-seeded", async () => {
    const ctx = makeCtx({ conventions: [{ path: "AGENTS.md", content: "preloaded", truncated: false }] })
    await loadConventions(ctx, fakeProfile)
    expect(loadConventionsSpy).not.toHaveBeenCalled()
    expect((ctx.data.conventions as Array<{ path: string }>)[0]?.path).toBe("AGENTS.md")
  })

  it("loads fresh when conventions absent", async () => {
    const ctx = makeCtx()
    await loadConventions(ctx, fakeProfile)
    expect(loadConventionsSpy).toHaveBeenCalledTimes(1)
  })
})

describe("Phase 5 fast path: loadCoverageRules", () => {
  it("skips when ctx.data.coverageRules is pre-seeded", async () => {
    const ctx = makeCtx({ coverageRules: [] })
    await loadCoverageRules(ctx, fakeProfile)
    // Preloaded empty array survives — was NOT overwritten with config.testRequirements
    expect(ctx.data.coverageRules).toEqual([])
  })

  it("loads from config when absent", async () => {
    const ctx = makeCtx()
    await loadCoverageRules(ctx, fakeProfile)
    expect((ctx.data.coverageRules as unknown[]).length).toBe(1)
  })
})

describe("Phase 5 fast path: loadPriorArt", () => {
  it("skips when ctx.data.priorArt is already a string (even if empty)", async () => {
    const ctx = makeCtx({ priorArt: "preloaded prior" })
    await loadPriorArt(ctx, fakeProfile)
    expect(ctx.data.priorArt).toBe("preloaded prior")
  })

  it("treats empty-string priorArt as legitimate preloaded value", async () => {
    const ctx = makeCtx({ priorArt: "" })
    await loadPriorArt(ctx, fakeProfile)
    expect(ctx.data.priorArt).toBe("")
  })
})

describe("Phase 5 fast path: loadMemoryContext", () => {
  it("skips when ctx.data.memoryContext is already a string", async () => {
    const ctx = makeCtx({ memoryContext: "preloaded memory" })
    await loadMemoryContext(ctx, fakeProfile)
    expect(ctx.data.memoryContext).toBe("preloaded memory")
  })
})
