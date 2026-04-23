import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    if (args[0] === "diff" && args[1] === "--shortstat") {
      return " 2 files changed, 10 insertions(+), 20 deletions(-)\n"
    }
    return ""
  }),
}))

vi.mock("../../src/issue.js", () => ({
  getIssue: vi.fn(() => ({ comments: [] })),
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
}))

vi.mock("../../src/lifecycleLabels.js", () => ({
  setKodyLabel: vi.fn(),
}))

import type { Context, Profile } from "../../src/executables/types.js"
import {
  getIssue,
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
} from "../../src/issue.js"
import { setKodyLabel } from "../../src/lifecycleLabels.js"
import { riskGate } from "../../src/scripts/riskGate.js"

type IssueComment = { body: string; createdAt: string; author: string }

function mockIssueComments(map: Record<number, IssueComment[]>) {
  vi.mocked(getIssue).mockImplementation((n: number) => {
    const comments = map[n] ?? []
    return {
      number: n,
      title: "",
      body: "",
      comments,
      labels: [],
    }
  })
}

function makeCtx(overrides: {
  changedFiles?: string[]
  target?: "issue" | "pr"
  targetNumber?: number
  flowIssueNumber?: number
  branch?: string
}): Context {
  const {
    changedFiles = [],
    target = "issue",
    targetNumber = 1,
    flowIssueNumber,
    branch = "feat-x",
  } = overrides
  const data: Record<string, unknown> = {
    commentTargetType: target,
    commentTargetNumber: targetNumber,
    changedFiles,
    branch,
  }
  if (flowIssueNumber !== undefined) {
    data.taskState = { flow: { issueNumber: flowIssueNumber } }
  }
  return {
    args: {},
    cwd: "/tmp",
    config: { git: { defaultBranch: "main" } } as Context["config"],
    data,
    output: { exitCode: 0 },
  }
}

const runProfile = { name: "run" } as Profile
const choreProfile = { name: "chore" } as Profile

beforeEach(() => {
  vi.clearAllMocks()
  mockIssueComments({})
})

describe("riskGate: no violations", () => {
  it("allows when no changed files", async () => {
    const ctx = makeCtx({ changedFiles: [] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
    expect(setKodyLabel).not.toHaveBeenCalled()
    expect(ghPostIssueComment).not.toHaveBeenCalled()
  })

  it("allows ordinary source changes", async () => {
    const ctx = makeCtx({ changedFiles: ["src/a.ts", "src/b.ts", "README.md"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })
})

describe("riskGate: secrets gate (hard, informational)", () => {
  it("halts on .env file", async () => {
    const ctx = makeCtx({ changedFiles: [".env", "src/a.ts"], targetNumber: 1 })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
    expect(setKodyLabel).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ label: "kody:waiting" }),
      "/tmp",
    )
    expect(ghPostIssueComment).toHaveBeenCalledOnce()
  })

  it("halts on api-secrets.json (keyword in basename)", async () => {
    const ctx = makeCtx({ changedFiles: ["config/api-secrets.json"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("halts on db.credentials.yaml", async () => {
    const ctx = makeCtx({ changedFiles: ["src/db.credentials.yaml"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("does NOT false-positive on secretary.md", async () => {
    const ctx = makeCtx({ changedFiles: ["docs/secretary.md"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })
})

describe("riskGate: other gates", () => {
  it("halts on workflow edit", async () => {
    const ctx = makeCtx({ changedFiles: [".github/workflows/ci.yml"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("halts on large-diff (file count over threshold)", async () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const ctx = makeCtx({ changedFiles: files })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("halts on dep-change outside chore flow", async () => {
    const ctx = makeCtx({ changedFiles: ["package.json"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("allows dep-change in chore flow", async () => {
    const ctx = makeCtx({ changedFiles: ["package.json"] })
    await riskGate(ctx, choreProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })
})

describe("riskGate: comment-based approval", () => {
  it("allows when an @kody2 approve comment exists after the advisory", async () => {
    mockIssueComments({
      1: [
        { body: "⏸️ kody2 risk gate halted the flow. ...", createdAt: "2026-04-23T10:00:00Z", author: "kody-bot" },
        { body: "@kody2 approve", createdAt: "2026-04-23T10:05:00Z", author: "alice" },
      ],
    })
    const ctx = makeCtx({ changedFiles: [".env"], targetNumber: 1 })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
    expect(setKodyLabel).not.toHaveBeenCalled()
    expect(ghPostIssueComment).not.toHaveBeenCalled()
  })

  it("does NOT approve when @kody2 approve predates the latest advisory", async () => {
    mockIssueComments({
      1: [
        { body: "@kody2 approve", createdAt: "2026-04-23T09:00:00Z", author: "alice" },
        { body: "⏸️ kody2 risk gate halted the flow. ...", createdAt: "2026-04-23T10:00:00Z", author: "kody-bot" },
      ],
    })
    const ctx = makeCtx({ changedFiles: [".env"], targetNumber: 1 })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("approves via an @kody2 approve on the originating issue when target is PR", async () => {
    mockIssueComments({
      // PR side: no approval
      123: [
        { body: "⏸️ kody2 risk gate halted the flow. ...", createdAt: "2026-04-23T10:00:00Z", author: "kody-bot" },
      ],
      // Issue side: approval after advisory
      42: [
        { body: "⏸️ kody2 risk gate halted the flow. ...", createdAt: "2026-04-23T10:00:00Z", author: "kody-bot" },
        { body: "@kody2 approve", createdAt: "2026-04-23T10:05:00Z", author: "alice" },
      ],
    })
    const ctx = makeCtx({
      changedFiles: [".env"],
      target: "pr",
      targetNumber: 123,
      flowIssueNumber: 42,
    })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })

  it("ignores random comments that don't match the @kody2 approve pattern", async () => {
    mockIssueComments({
      1: [
        { body: "⏸️ kody2 risk gate halted the flow. ...", createdAt: "2026-04-23T10:00:00Z", author: "kody-bot" },
        { body: "lgtm, looks fine", createdAt: "2026-04-23T10:05:00Z", author: "alice" },
        { body: "please approve", createdAt: "2026-04-23T10:06:00Z", author: "bob" },
      ],
    })
    const ctx = makeCtx({ changedFiles: [".env"], targetNumber: 1 })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })
})

describe("riskGate: advisory and output", () => {
  it("posts advisory to PR when target is PR", async () => {
    const ctx = makeCtx({
      changedFiles: [".github/workflows/ci.yml"],
      target: "pr",
      targetNumber: 42,
    })
    await riskGate(ctx, runProfile, null)
    expect(ghPostPrReviewComment).toHaveBeenCalledOnce()
    expect(ghPostIssueComment).not.toHaveBeenCalled()
  })

  it("writes a reason into ctx.output when halting", async () => {
    const ctx = makeCtx({ changedFiles: [".env"] })
    await riskGate(ctx, runProfile, null)
    expect(ctx.output.reason).toContain("secrets")
  })

  it("does not overwrite an existing output.reason", async () => {
    const ctx = makeCtx({ changedFiles: [".env"] })
    ctx.output.reason = "prior failure"
    await riskGate(ctx, runProfile, null)
    expect(ctx.output.reason).toBe("prior failure")
  })
})

describe("riskGate: selective gates via args.gates", () => {
  it("only evaluates the requested gate", async () => {
    const ctx = makeCtx({ changedFiles: [".env", "package.json"] })
    await riskGate(ctx, runProfile, null, { gates: "secrets" })
    const rg = ctx.data.riskGate as { violations: Array<{ name: string }> }
    expect(rg.violations.map((v) => v.name)).toEqual(["secrets"])
  })

  it("falls back to all gates when input is unrecognized", async () => {
    const ctx = makeCtx({ changedFiles: ["package.json"] })
    await riskGate(ctx, runProfile, null, { gates: "nonsense" })
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })
})
