import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    if (args[0] === "diff" && args[1] === "--shortstat") {
      return " 2 files changed, 10 insertions(+), 20 deletions(-)\n"
    }
    if (args[0] === "show" && args[1] === "--name-status") {
      return "" // no deletions by default
    }
    return ""
  }),
}))

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(() => ""),
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
}))

vi.mock("../../src/lifecycleLabels.js", () => ({
  getIssueLabels: vi.fn(() => [] as string[]),
  setKodyLabel: vi.fn(),
}))

import type { Context, Profile } from "../../src/executables/types.js"
import {
  gh,
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
} from "../../src/issue.js"
import { getIssueLabels, setKodyLabel } from "../../src/lifecycleLabels.js"
import { riskGate } from "../../src/scripts/riskGate.js"

function makeCtx(overrides: {
  changedFiles?: string[]
  labels?: string[]
  target?: "issue" | "pr"
  targetNumber?: number
}): Context {
  const { changedFiles = [], labels = [], target = "issue", targetNumber = 1 } = overrides
  vi.mocked(getIssueLabels).mockReturnValue(labels)
  return {
    args: {},
    cwd: "/tmp",
    config: { git: { defaultBranch: "main" } } as Context["config"],
    data: {
      commentTargetType: target,
      commentTargetNumber: targetNumber,
      changedFiles,
    },
    output: { exitCode: 0 },
  }
}

const runProfile = { name: "run" } as Profile
const choreProfile = { name: "chore" } as Profile

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getIssueLabels).mockReturnValue([])
})

describe("riskGate: no violations", () => {
  it("allows and writes decision when no changed files", async () => {
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

describe("riskGate: secrets (hard gate)", () => {
  it("halts when a .env file is touched", async () => {
    const ctx = makeCtx({ changedFiles: [".env", "src/a.ts"] })
    await riskGate(ctx, runProfile, null)
    const rg = ctx.data.riskGate as { decision: string; pending: Array<{ name: string }> }
    expect(rg.decision).toBe("halt")
    expect(rg.pending.some((p) => p.name === "secrets")).toBe(true)
    expect(setKodyLabel).toHaveBeenCalledOnce()
    expect(setKodyLabel).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ label: "kody:gated" }),
      "/tmp",
    )
    expect(ghPostIssueComment).toHaveBeenCalledOnce()
  })

  it("halts when a .pem file is touched", async () => {
    const ctx = makeCtx({ changedFiles: ["keys/server.pem"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("halts on filenames containing 'secrets' anywhere in the basename", async () => {
    const ctx = makeCtx({ changedFiles: ["config/api-secrets.json"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("halts on filenames containing 'credentials' as a word", async () => {
    const ctx = makeCtx({ changedFiles: ["src/db.credentials.yaml"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("halts on filenames containing 'password'", async () => {
    const ctx = makeCtx({ changedFiles: ["data/user-passwords.txt"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("does NOT false-positive on 'secretary.md' (word boundary)", async () => {
    const ctx = makeCtx({ changedFiles: ["docs/secretary.md"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })

  it("is NOT bypassed by kody-approve:all (hard gate)", async () => {
    const ctx = makeCtx({ changedFiles: [".env"], labels: ["kody-approve:all"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("is approved by kody-approve:secrets specifically", async () => {
    const ctx = makeCtx({ changedFiles: [".env"], labels: ["kody-approve:secrets"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
    expect(setKodyLabel).not.toHaveBeenCalled()
    expect(ghPostIssueComment).not.toHaveBeenCalled()
  })

  it("pre-creates the kody-approve:secrets label on halt", async () => {
    const ctx = makeCtx({ changedFiles: [".env"] })
    await riskGate(ctx, runProfile, null)
    const calls = vi.mocked(gh).mock.calls
    const createCall = calls.find(
      (c) => c[0][0] === "label" && c[0][1] === "create" && c[0][2] === "kody-approve:secrets",
    )
    expect(createCall).toBeDefined()
  })
})

describe("riskGate: workflow-edit (soft gate)", () => {
  it("halts when .github/workflows is edited", async () => {
    const ctx = makeCtx({ changedFiles: [".github/workflows/ci.yml"] })
    await riskGate(ctx, runProfile, null)
    const rg = ctx.data.riskGate as { decision: string; pending: Array<{ name: string }> }
    expect(rg.decision).toBe("halt")
    expect(rg.pending[0]!.name).toBe("workflow-edit")
  })

  it("is approved by kody-approve:workflow-edit", async () => {
    const ctx = makeCtx({
      changedFiles: [".github/workflows/ci.yml"],
      labels: ["kody-approve:workflow-edit"],
    })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })

  it("is approved by kody-approve:all (soft gate)", async () => {
    const ctx = makeCtx({
      changedFiles: [".github/workflows/ci.yml"],
      labels: ["kody-approve:all"],
    })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })

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
})

describe("riskGate: large-diff (soft gate)", () => {
  it("halts when file count exceeds threshold", async () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`)
    const ctx = makeCtx({ changedFiles: many })
    await riskGate(ctx, runProfile, null)
    const rg = ctx.data.riskGate as { decision: string; pending: Array<{ name: string }> }
    expect(rg.decision).toBe("halt")
    expect(rg.pending[0]!.name).toBe("large-diff")
  })

  it("respects a custom maxFiles threshold", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`)
    const ctx = makeCtx({ changedFiles: files })
    await riskGate(ctx, runProfile, null, { maxFiles: 5 })
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
  })

  it("does not trip at or below threshold", async () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`)
    const ctx = makeCtx({ changedFiles: files })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })
})

describe("riskGate: dep-change (soft gate)", () => {
  it("halts on package.json change in non-chore flow", async () => {
    const ctx = makeCtx({ changedFiles: ["package.json"] })
    await riskGate(ctx, runProfile, null)
    const rg = ctx.data.riskGate as { decision: string; pending: Array<{ name: string }> }
    expect(rg.decision).toBe("halt")
    expect(rg.pending[0]!.name).toBe("dep-change")
  })

  it("allows package.json change in chore flow", async () => {
    const ctx = makeCtx({ changedFiles: ["package.json"] })
    await riskGate(ctx, choreProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("allow")
  })

  it("halts on lockfile change", async () => {
    const ctx = makeCtx({ changedFiles: ["pnpm-lock.yaml"] })
    await riskGate(ctx, runProfile, null)
    expect((ctx.data.riskGate as { decision: string }).decision).toBe("halt")
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

describe("riskGate: output.reason", () => {
  it("populates output.reason with the tripped gate names", async () => {
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
