import * as childProcess from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { Context, Profile } from "../../src/implementations/types.js"
import { setKodyLabel } from "../../src/lifecycleLabels.js"
import { advanceFlow } from "../../src/scripts/advanceFlow.js"
import { dispatch } from "../../src/scripts/dispatch.js"
import { finalizeTerminal } from "../../src/scripts/finalizeTerminal.js"
import { finishFlow } from "../../src/scripts/finishFlow.js"
import { startFlow } from "../../src/scripts/startFlow.js"
import { emptyState, type FlowState, type TaskState } from "../../src/state.js"

const setKodyLabelMock = setKodyLabel as unknown as Mock

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, execFileSync: vi.fn() }
})

vi.mock("../../src/lifecycleLabels.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lifecycleLabels.js")>("../../src/lifecycleLabels.js")
  return { ...actual, setKodyLabel: vi.fn() }
})
const backendMocks = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => ({ save: backendMocks.save }),
}))

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
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
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
  execFileSync.mockImplementation((_cmd, args: unknown) => {
    const a = (args as string[]) ?? []
    if (a[0] === "api" && a.some((arg) => arg.includes("/contents/"))) {
      if (a.includes("PUT")) return "{}"
      throw new Error("HTTP 404 Not Found")
    }
    return ""
  })
  setKodyLabelMock.mockReset()
  backendMocks.save.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe("startFlow", () => {
  it("seeds state.flow using the profile name, then hands the first child to kody-cli in-process", async () => {
    const state: TaskState = { ...emptyState() }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "plan", target: "issue" })
    // flow.name must come from the profile (the orchestrator's own name),
    // not from a removed --flow CLI arg.
    expect(state.flow).toMatchObject({ name: "bug", step: "plan", issueNumber: 42 })
    // In-process hand-off, NOT an @kody comment (which a bot can't self-trigger).
    expect(c.output.nextDispatch).toEqual({ action: "plan", cliArgs: { issue: 42 } })
    expect(execFileSync).not.toHaveBeenCalled()
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
    expect(c.output.nextDispatch).toBeUndefined()
    expect(state.flow).toBe(flow)
  })

  it("targets the PR when target=pr and prUrl is present in state", async () => {
    const state: TaskState = {
      ...emptyState(),
      core: { ...emptyState().core, prUrl: "https://github.com/o/r/pull/77" },
    }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "review", target: "pr" })
    expect(c.output.nextDispatch).toEqual({ action: "review", cliArgs: { pr: 77 } })
  })

  it("falls back to issue when target=pr but no prUrl exists", async () => {
    const state: TaskState = { ...emptyState() }
    const c = ctx({ data: { taskState: state }, args: { issue: 42 } })
    await startFlow(c, profile("bug"), null, { entry: "review", target: "pr" })
    expect(c.output.nextDispatch).toEqual({ action: "review", cliArgs: { issue: 42 } })
  })

  it("no-ops without crashing when `with.entry` is missing", async () => {
    const c = ctx()
    await startFlow(c, profile(), null, {})
    expect(c.output.nextDispatch).toBeUndefined()
  })
})

describe("dispatch", () => {
  it("hands the next stage to kody-cli in-process and updates state.flow.step", async () => {
    const flow: FlowState = { name: "f", step: "plan", issueNumber: 42, startedAt: "t" }
    const state: TaskState = { ...emptyState(), flow }
    const c = ctx({ data: { taskState: state } })
    await dispatch(c, profile(), null, { next: "run", target: "issue" })
    expect(state.flow?.step).toBe("run")
    expect(c.output.nextDispatch).toEqual({ action: "run", cliArgs: { issue: 42 } })
    expect(execFileSync).not.toHaveBeenCalled()
  })

  it("targets the PR when target=pr and prUrl is set", async () => {
    const state: TaskState = {
      ...emptyState(),
      core: { ...emptyState().core, prUrl: "https://github.com/o/r/pull/9" },
      flow: { name: "f", step: "run", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state } })
    await dispatch(c, profile(), null, { next: "review", target: "pr" })
    expect(c.output.nextDispatch).toEqual({ action: "review", cliArgs: { pr: 9 } })
  })

  it("no-ops without crashing when `with.next` is missing", async () => {
    const c = ctx()
    await dispatch(c, profile(), null, {})
    expect(c.output.nextDispatch).toBeUndefined()
  })

  it("aborts when target=pr but no prUrl — emits AGENT_NOT_RUN and hands off nothing", async () => {
    const state: TaskState = {
      ...emptyState(),
      flow: { name: "f", step: "run", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state } })
    await dispatch(c, profile(), null, { next: "review", target: "pr" })
    expect(c.output.nextDispatch).toBeUndefined()
    const action = c.data.action as { type: string; payload: { reason: string; next: string } }
    expect(action?.type).toBe("AGENT_NOT_RUN")
    expect(action?.payload?.next).toBe("review")
    expect(state.core.lastOutcome?.type).toBe("AGENT_NOT_RUN")
    // Step is NOT advanced — there's no transition to record.
    expect(state.flow?.step).toBe("run")
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
    // finishFlow now also writes the state mirror to flip phase=shipped on
    // success terminations; the first execFileSync call must still be the
    // human-readable summary comment, but subsequent calls write the state.
    const summaryCall = execFileSync.mock.calls.find((c) => (c[1] as string[])[0] === "issue")
    expect(summaryCall).toBeDefined()
    const args = summaryCall![1] as string[]
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

  it("applies the profile-declared terminal label to the issue and the PR when `with.label` is set", async () => {
    const state: TaskState = {
      ...emptyState(),
      core: { ...emptyState().core, prUrl: "https://github.com/o/r/pull/99" },
      flow: { name: "f", step: "x", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ args: { issue: 42 }, data: { taskState: state } })
    await finishFlow(c, profile(), null, {
      reason: "review-passed",
      label: "kody:done",
      color: "0e8a16",
      description: "done",
    })
    const spec = { label: "kody:done", color: "0e8a16", description: "done" }
    expect(setKodyLabelMock).toHaveBeenCalledWith(42, spec, "/tmp")
    expect(setKodyLabelMock).toHaveBeenCalledWith(99, spec, "/tmp")
    expect(setKodyLabelMock).toHaveBeenCalledTimes(2)
  })

  it("labels only the issue when no PR URL is on state", async () => {
    const state: TaskState = { ...emptyState(), flow: { name: "f", step: "x", issueNumber: 42, startedAt: "t" } }
    const c = ctx({ args: { issue: 42 }, data: { taskState: state } })
    await finishFlow(c, profile(), null, { reason: "aborted", label: "kody:failed" })
    expect(setKodyLabelMock).toHaveBeenCalledTimes(1)
    expect(setKodyLabelMock).toHaveBeenCalledWith(42, expect.objectContaining({ label: "kody:failed" }), "/tmp")
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

  it("re-triggers the sub-orchestrator by flow name in-process when a flow is in progress", async () => {
    const state: TaskState = {
      ...emptyState(),
      flow: { name: "bug", step: "plan", issueNumber: 42, startedAt: "t" },
    }
    const c = ctx({ data: { taskState: state, commentTargetType: "issue" } })
    await advanceFlow(c, profile("plan"), null)
    expect(c.output.nextDispatch).toEqual({ action: "bug", cliArgs: { issue: 42 } })
  })

  it("re-runs <flow.name> in-process regardless of which child just finished", async () => {
    const state: TaskState = {
      ...emptyState(),
      flow: { name: "feature", step: "run", issueNumber: 7, startedAt: "t" },
    }
    const c = ctx({ args: { issue: 7 }, data: { taskState: state, commentTargetType: "issue" } })
    await advanceFlow(c, profile("run"), null)
    expect(c.output.nextDispatch).toEqual({ action: "feature", cliArgs: { issue: 7 } })
  })

  it("for PR-targeted children also mirrors action to the issue state and re-triggers by flow name", async () => {
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
    expect(backendMocks.save).toHaveBeenCalledOnce()
    const stateJson = JSON.stringify(backendMocks.save.mock.calls[0]![3])
    expect(stateJson).toContain("REVIEW_PASS")
    expect(c.output.nextDispatch).toEqual({ action: "bug", cliArgs: { issue: 42 } })
  })
})

describe("finalizeTerminal", () => {
  it("defers to the orchestrator (no terminal label) when an active flow is present", async () => {
    const flow: FlowState = { name: "bug", step: "review", issueNumber: 42, startedAt: "t" }
    const state: TaskState = { ...emptyState(), flow }
    const c = ctx({ data: { taskState: state, commentTargetType: "pr", commentTargetNumber: 99 } })
    await finalizeTerminal(c, profile("fix"), null)
    // Orchestrator owns the terminal stamp + state write — child must not touch either.
    expect(setKodyLabelMock).not.toHaveBeenCalled()
    expect(execFileSync).not.toHaveBeenCalled()
  })
})
