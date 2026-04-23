import * as childProcess from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { advanceFlow } from "../../src/scripts/advanceFlow.js"
import { dispatch } from "../../src/scripts/dispatch.js"
import { setKodyLabel } from "../../src/lifecycleLabels.js"
import { finishFlow } from "../../src/scripts/finishFlow.js"
import { startFlow } from "../../src/scripts/startFlow.js"
import { emptyState, type FlowState, STATE_BEGIN, STATE_END, type TaskState } from "../../src/state.js"

const setKodyLabelMock = setKodyLabel as unknown as Mock

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, execFileSync: vi.fn() }
})

vi.mock("../../src/lifecycleLabels.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lifecycleLabels.js")>(
    "../../src/lifecycleLabels.js",
  )
  return { ...actual, setKodyLabel: vi.fn() }
})

const execFileSync = childProcess.execFileSync as unknown as Mock

function profile(name = "orchestrator"): Profile {
  return {
    name,
    role: "orchestrator",
    describe: "test",
    kind: "oneshot",
    inputs: [],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: null,
      maxThinkingTokens: null,
      systemPromptAppend: null,
      tools: [],
      hooks: [],
      skills: [],
      commands: [],
      subagents: [],
      plugins: [],
      mcpServers: [],
    },
    cliTools: [],
    scripts: { preflight: [], postflight: [] },
    inputArtifacts: [],
    outputArtifacts: [],
    dir: "/tmp",
  }
}

function ctx(overrides: Partial<Context> = {}): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/claude-haiku-4-5-20251001" },
    },
    data: {},
    output: { exitCode: 0 },
    ...overrides,
  }
}

beforeEach(() => {
  execFileSync.mockReset()
  setKodyLabelMock.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe("startFlow", () => {
  it("seeds state.flow using the profile name, then posts @kody <entry> on the issue", async () => {
    const state: TaskState = { ...emptyState() }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "plan", target: "issue" })
    // flow.name must come from the profile (the orchestrator's own name),
    // not from a removed --flow CLI arg.
    expect(state.flow).toMatchObject({ name: "bug", step: "plan", issueNumber: 42 })
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["issue", "comment", "42", "--body", "@kody plan"],
      expect.any(Object),
    )
  })

  it("different profile name yields a different flow.name", async () => {
    const state: TaskState = { ...emptyState() }
    const c = ctx({ data: { taskState: state }, args: { issue: 7 } })
    await startFlow(c, profile("feature"), null, { entry: "research", target: "issue" })
    expect(state.flow?.name).toBe("feature")
  })

  it("is idempotent: no-op when state.flow is already set", async () => {
    const flow: FlowState = { name: "x", step: "plan", issueNumber: 42, startedAt: "2026-01-01T00:00:00Z" }
    const state: TaskState = { ...emptyState(), flow }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "plan" })
    expect(execFileSync).not.toHaveBeenCalled()
    expect(state.flow).toBe(flow)
  })

  it("targets the PR when target=pr and prUrl is present in state", async () => {
    const state: TaskState = { ...emptyState(), core: { ...emptyState().core, prUrl: "https://github.com/o/r/pull/77" } }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "review", target: "pr" })
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["pr", "comment", "77", "--body", "@kody review"],
      expect.any(Object),
    )
  })

  it("falls back to issue when target=pr but no prUrl exists", async () => {
    const state: TaskState = { ...emptyState() }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "review", target: "pr" })
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["issue", "comment", "42", "--body", "@kody review"],
      expect.any(Object),
    )
  })

  it("no-ops without crashing when `with.entry` is missing", async () => {
    const c = ctx()
    await startFlow(c, profile(), null, {})
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe("dispatch", () => {
  it("posts @kody <next> on the issue and updates state.flow.step", async () => {
    const flow: FlowState = { name: "f", step: "plan", issueNumber: 42, startedAt: "t" }
    const state: TaskState = { ...emptyState(), flow }
    const c = ctx({ data: { taskState: state } })
    await dispatch(c, profile(), null, { next: "run", target: "issue" })
    expect(state.flow?.step).toBe("run")
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["issue", "comment", "42", "--body", "@kody run"],
      expect.any(Object),
    )
  })

  it("targets the PR when target=pr and prUrl is set", async () => {
    const state: TaskState = {
      ...emptyState(),
      core: { ...emptyState().core, prUrl: "https://github.com/o/r/pull/9" },
      flow: { name: "f", step: "run", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state } })
    await dispatch(c, profile(), null, { next: "review", target: "pr" })
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["pr", "comment", "9", "--body", "@kody review"],
      expect.any(Object),
    )
  })

  it("no-ops without crashing when `with.next` is missing", async () => {
    const c = ctx()
    await dispatch(c, profile(), null, {})
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe("finishFlow", () => {
  it("clears state.flow and posts a summary on the issue", async () => {
    const state: TaskState = {
      ...emptyState(),
      flow: { name: "plan-build-review", step: "fix", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state } })
    await finishFlow(c, profile(), null, { reason: "fix-applied" })
    expect(state.flow).toBeUndefined()
    expect(execFileSync).toHaveBeenCalledTimes(1)
    const args = execFileSync.mock.calls[0]![1] as string[]
    expect(args.slice(0, 3)).toEqual(["issue", "comment", "42"])
    expect(args[4]).toContain("plan-build-review")
    expect(args[4]).toContain("fix-applied")
  })

  it("uses an unknown-icon for an unrecognized reason", async () => {
    const state: TaskState = { ...emptyState(), flow: { name: "f", step: "x", issueNumber: 1, startedAt: "t" } }
    const c = ctx({ args: { issue: 1 }, data: { taskState: state } })
    await finishFlow(c, profile(), null, { reason: "weird-thing" })
    const args = execFileSync.mock.calls[0]![1] as string[]
    expect(args[4]).toContain("ℹ️")
    expect(args[4]).toContain("weird-thing")
  })

  it("applies the profile-declared terminal label when `with.label` is set", async () => {
    const state: TaskState = {
      ...emptyState(),
      core: { ...emptyState().core, prUrl: "https://github.com/o/r/pull/42" },
      flow: { name: "f", step: "x", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state } })
    await finishFlow(c, profile(), null, {
      reason: "review-passed",
      label: "kody:done",
      color: "0e8a16",
      description: "done",
    })
    expect(setKodyLabelMock).toHaveBeenCalledWith(
      42,
      { label: "kody:done", color: "0e8a16", description: "done" },
      "/tmp",
    )
  })

  it("does NOT label when `with.label` is missing", async () => {
    const state: TaskState = { ...emptyState(), flow: { name: "f", step: "x", issueNumber: 42, startedAt: "t" } }
    const c = ctx({ data: { taskState: state } })
    await finishFlow(c, profile(), null, { reason: "completed" })
    expect(setKodyLabelMock).not.toHaveBeenCalled()
  })

  it("does NOT label when `with.label` is not a kody: label", async () => {
    const state: TaskState = { ...emptyState(), flow: { name: "f", step: "x", issueNumber: 42, startedAt: "t" } }
    const c = ctx({ data: { taskState: state } })
    await finishFlow(c, profile(), null, { reason: "completed", label: "bug" })
    expect(setKodyLabelMock).not.toHaveBeenCalled()
  })
})

describe("advanceFlow", () => {
  it("no-ops when no flow is in progress", async () => {
    const state: TaskState = { ...emptyState() }
    const c = ctx({ data: { taskState: state } })
    await advanceFlow(c, profile("plan"), null)
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it("re-triggers the sub-orchestrator by flow name when a flow is in progress", async () => {
    const state: TaskState = {
      ...emptyState(),
      flow: { name: "bug", step: "plan", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state, commentTargetType: "issue" } })
    await advanceFlow(c, profile("plan"), null)
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["issue", "comment", "42", "--body", "@kody bug"],
      expect.any(Object),
    )
  })

  it("posts @kody <flow.name> regardless of which child just finished", async () => {
    const state: TaskState = {
      ...emptyState(),
      flow: { name: "feature", step: "run", issueNumber: 7, startedAt: "t" },
    }
    const c = ctx({ args: { issue: 7 }, data: { taskState: state, commentTargetType: "issue" } })
    await advanceFlow(c, profile("run"), null)
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      ["issue", "comment", "7", "--body", "@kody feature"],
      expect.any(Object),
    )
  })

  it("for PR-targeted children also mirrors action to the issue state and re-triggers by flow name", async () => {
    const issueStateBody = `${STATE_BEGIN}\n\n\`\`\`json\n${JSON.stringify(emptyState())}\n\`\`\`\n\n${STATE_END}`
    execFileSync.mockImplementation((_cmd, args: unknown) => {
      const a = (args as string[]) ?? []
      if (a[0] === "api" && (a[1] === "--paginate" || a[1]?.includes("comments"))) {
        return JSON.stringify([{ id: 999, body: issueStateBody }])
      }
      return ""
    })
    const flow: FlowState = { name: "bug", step: "review", issueNumber: 42, startedAt: "t" }
    const state: TaskState = { ...emptyState(), flow }
    const c = ctx({
      data: {
        taskState: state,
        commentTargetType: "pr",
        action: { type: "REVIEW_PASS", payload: {}, timestamp: "2026-01-01T00:00:00Z" },
      },
    })
    await advanceFlow(c, profile("review"), null)
    const calls = execFileSync.mock.calls.map((c) => (c[1] as string[]) ?? [])
    const patchCall = calls.find((a) => a.includes("PATCH"))
    const triggerCall = calls.find((a) => a.join(" ").includes("@kody bug"))
    expect(patchCall).toBeDefined()
    expect(triggerCall).toBeDefined()
  })
})
