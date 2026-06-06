/**
 * Container role tests.
 *
 * Containers are the in-process alternative to comment-based orchestrators.
 * The executor runs each declared child sequentially, reads the action type
 * the child wrote into state.core.lastOutcome, and routes via the child's
 * `next` map ("done" / "abort" / another child name).
 *
 * Children are mocked via the `__runChild` test seam — these tests never
 * spin up real executables. A matching `__readTaskState` stub feeds the
 * "what did the child just write" lookup.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ExecutorInput, ExecutorOutput } from "../../src/executor.js"
import { runExecutable } from "../../src/executor.js"
import { loadProfile } from "../../src/profile.js"
import { type Action, emptyState, type TaskState, type TaskTarget } from "../../src/state.js"

// Each test below `process.chdir()`s into a throwaway temp root and never
// restored it — leaving the worker fork's cwd in a stray /tmp dir that later
// test files inherit (and that breaks git/gh spawns relying on cwd, which only
// surfaces on Linux CI, not macOS). Restore the real cwd after every test.
const ORIGINAL_CWD = process.cwd()
afterEach(() => process.chdir(ORIGINAL_CWD))

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

/** Build a minimal container profile in a fresh project root. Returns the cwd. */
function makeContainerFixture(opts: {
  containerName: string
  children: Array<{ exec: string; target: "issue" | "pr"; next: Record<string, string> }>
}): string {
  const root = tmpDir("kody-container")
  const exeDir = path.join(root, ".kody", "executables", opts.containerName)
  fs.mkdirSync(exeDir, { recursive: true })
  const profile = {
    name: opts.containerName,
    role: "container",
    describe: "test container",
    kind: "oneshot",
    inputs: [
      {
        name: "issue",
        flag: "--issue",
        type: "int",
        required: true,
        describe: "Issue number to drive on.",
      },
    ],
    claudeCode: {
      model: "inherit",
      permissionMode: "default",
      maxTurns: 0,
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
    children: opts.children,
  }
  fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile, null, 2))
  return root
}

/** Synthesize an Action of the given type. */
function action(type: string, payload: Record<string, unknown> = {}): Action {
  return { type, payload, timestamp: new Date().toISOString() }
}

/**
 * Build a __runChild + __readTaskState pair backed by a shared in-memory
 * TaskState. Each invocation script declares which child name to expect,
 * the action it should record, and any state mutations (e.g. setting prUrl).
 *
 * Returns helpers + the running state so tests can assert call order and
 * state at the end of the run.
 */
function makeMockEnvironment(
  scripts: Array<{
    exec: string
    onInvoke?: (state: TaskState) => Action | null
    exitCode?: number
  }>,
): {
  runChild: NonNullable<ExecutorInput["__runChild"]>
  readTaskState: NonNullable<ExecutorInput["__readTaskState"]>
  state: TaskState
  calls: Array<{ name: string; cliArgs: Record<string, unknown> }>
} {
  const state: TaskState = emptyState()
  const calls: Array<{ name: string; cliArgs: Record<string, unknown> }> = []

  const runChild: NonNullable<ExecutorInput["__runChild"]> = async (name, input): Promise<ExecutorOutput> => {
    calls.push({ name, cliArgs: input.cliArgs })
    const script = scripts.find((s) => s.exec === name)
    if (!script) {
      return { exitCode: 99, reason: `unexpected child invocation: ${name}` }
    }
    const a = script.onInvoke?.(state)
    if (a) {
      state.core.lastOutcome = a
      state.core.attempts[name] = (state.core.attempts[name] ?? 0) + 1
      state.executables[name] = { lastAction: a }
      state.history.push({
        timestamp: a.timestamp,
        executable: name,
        action: a.type,
      })
    }
    return { exitCode: script.exitCode ?? 0 }
  }

  const readTaskState: NonNullable<ExecutorInput["__readTaskState"]> = (
    _target: TaskTarget,
    _num: number,
    _cwd?: string,
  ): TaskState => {
    // Return a deep-ish clone so callers can't mutate the canonical state.
    return JSON.parse(JSON.stringify(state)) as TaskState
  }

  return { runChild, readTaskState, state, calls }
}

describe("container: smoke fixture", () => {
  it("loads tests/fixtures/container-smoke/smoke-container without errors", () => {
    const profilePath = path.resolve(__dirname, "../fixtures/container-smoke/smoke-container/profile.json")
    const profile = loadProfile(profilePath)
    expect(profile.name).toBe("smoke-container")
    expect(profile.role).toBe("container")
    expect(profile.children).toHaveLength(2)
    expect(profile.children?.[0]?.exec).toBe("echo-a")
    expect(profile.children?.[0]?.next.ECHO_A_COMPLETED).toBe("echo-b")
    expect(profile.children?.[1]?.exec).toBe("echo-b")
    expect(profile.children?.[1]?.next.ECHO_B_COMPLETED).toBe("done")
  })
})

describe("container: profile loading", () => {
  it("loads a valid container profile with children", () => {
    const root = makeContainerFixture({
      containerName: "demo",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const profile = loadProfile(path.join(root, ".kody", "executables", "demo", "profile.json"))
    expect(profile.role).toBe("container")
    expect(profile.children).toHaveLength(2)
    expect(profile.children?.[0]?.exec).toBe("plan")
    expect(profile.children?.[0]?.next.PLAN_COMPLETED).toBe("run")
  })

  it("rejects a container profile with no children", () => {
    const root = makeContainerFixture({ containerName: "demo", children: [] })
    expect(() => loadProfile(path.join(root, ".kody", "executables", "demo", "profile.json"))).toThrow(
      /role: "container" requires a non-empty "children" array/,
    )
  })

  it("rejects an invalid child target", () => {
    const root = makeContainerFixture({
      containerName: "demo",
      children: [{ exec: "plan", target: "bogus" as "issue", next: { "*": "done" } }],
    })
    expect(() => loadProfile(path.join(root, ".kody", "executables", "demo", "profile.json"))).toThrow(
      /target must be "issue" or "pr"/,
    )
  })

  it("rejects children on a non-container role", () => {
    const root = tmpDir("kody-container-bad-role")
    const exeDir = path.join(root, ".kody", "executables", "bad")
    fs.mkdirSync(exeDir, { recursive: true })
    const profile = {
      name: "bad",
      role: "primitive",
      describe: "",
      kind: "oneshot",
      inputs: [],
      claudeCode: {
        model: "inherit",
        permissionMode: "default",
        maxTurns: 0,
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
      children: [{ exec: "plan", target: "issue", next: { "*": "done" } }],
    }
    fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify(profile))
    expect(() => loadProfile(path.join(exeDir, "profile.json"))).toThrow(
      /"children" is only allowed when role === "container"/,
    )
  })
})

describe("container: routing through children", () => {
  it("routes PLAN_COMPLETED → run, then RUN_COMPLETED → done", async () => {
    const root = makeContainerFixture({
      containerName: "plan-run",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "run", onInvoke: () => action("RUN_COMPLETED") },
    ])

    process.chdir(root)
    const result = await runExecutable("plan-run", {
      cliArgs: { issue: 42 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
    expect(env.calls.map((c) => c.name)).toEqual(["plan", "run"])
    expect(env.calls[0]?.cliArgs).toEqual({ issue: 42 })
  })

  it("aborts when a child action maps to 'abort'", async () => {
    const root = makeContainerFixture({
      containerName: "plan-abort",
      children: [
        {
          exec: "plan",
          target: "issue",
          next: { PLAN_COMPLETED: "run", PLAN_FAILED: "abort", "*": "abort" },
        },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_FAILED") },
      { exec: "run", onInvoke: () => action("RUN_COMPLETED") },
    ])

    process.chdir(root)
    const result = await runExecutable("plan-abort", {
      cliArgs: { issue: 42 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(env.calls.map((c) => c.name)).toEqual(["plan"]) // run never reached
    expect(result.reason).toMatch(/aborted by route/)
  })

  it("aborts when an action type has no route and no wildcard", async () => {
    const root = makeContainerFixture({
      containerName: "no-route",
      children: [{ exec: "plan", target: "issue", next: { PLAN_COMPLETED: "done" } }],
    })
    const env = makeMockEnvironment([{ exec: "plan", onInvoke: () => action("PLAN_FAILED") }])

    process.chdir(root)
    const result = await runExecutable("no-route", {
      cliArgs: { issue: 1 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/no route for action "PLAN_FAILED"/)
  })
})

describe("container: idempotency", () => {
  it("skips a child whose lastAction already ends in _COMPLETED", async () => {
    const root = makeContainerFixture({
      containerName: "resume",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      // plan should NOT be invoked — pre-seeded as completed.
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "run", onInvoke: () => action("RUN_COMPLETED") },
    ])
    // Pre-seed plan as already completed.
    const seeded = action("PLAN_COMPLETED")
    env.state.executables.plan = { lastAction: seeded }
    env.state.core.lastOutcome = seeded

    process.chdir(root)
    const result = await runExecutable("resume", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
    // Only run was invoked; plan's prior outcome routed us straight to run.
    expect(env.calls.map((c) => c.name)).toEqual(["run"])
  })
})

describe("container: PR target resolution", () => {
  it("aborts with AGENT_NOT_RUN when target=pr but state.core.prUrl is unset", async () => {
    const root = makeContainerFixture({
      containerName: "pr-target",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "review", "*": "abort" } },
        { exec: "review", target: "pr", next: { REVIEW_PASS: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "review", onInvoke: () => action("REVIEW_PASS") },
    ])

    process.chdir(root)
    const result = await runExecutable("pr-target", {
      cliArgs: { issue: 99 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/needs --pr but state\.core\.prUrl is unset/)
    expect(env.calls.map((c) => c.name)).toEqual(["plan"]) // review never reached
  })

  it("passes --pr to the child when state.core.prUrl is parseable", async () => {
    const root = makeContainerFixture({
      containerName: "pr-ok",
      children: [
        {
          exec: "plan",
          target: "issue",
          next: { PLAN_COMPLETED: "review", "*": "abort" },
        },
        { exec: "review", target: "pr", next: { REVIEW_PASS: "done", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      {
        exec: "plan",
        onInvoke: (state) => {
          state.core.prUrl = "https://github.com/o/r/pull/123"
          return action("PLAN_COMPLETED")
        },
      },
      { exec: "review", onInvoke: () => action("REVIEW_PASS") },
    ])

    process.chdir(root)
    const result = await runExecutable("pr-ok", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
    expect(env.calls).toHaveLength(2)
    expect(env.calls[0]?.cliArgs).toEqual({ issue: 7 })
    expect(env.calls[1]?.cliArgs).toEqual({ pr: 123 })
  })
})

describe("container: target-aware state reads", () => {
  // Regression: live-test on issue 3175 surfaced that readContainerState was
  // hard-wired to read from the issue thread, ignoring child.target. After a
  // child with target:"pr" wrote REVIEW_PASS to the PR's state comment, the
  // container re-read from the issue and saw the *prior* RUN_COMPLETED still
  // sitting there, then routed via the wildcard fallback to abort.

  it("reads from PR after a target:'pr' child finishes", async () => {
    // Two separate state buckets keyed by target. Without the fix the
    // container reads issueState.lastOutcome (PLAN_COMPLETED) instead of
    // prState.lastOutcome (REVIEW_PASS) and aborts via the "*" route.
    const issueState = emptyState()
    const prState = emptyState()

    const runChild: NonNullable<ExecutorInput["__runChild"]> = async (name): Promise<ExecutorOutput> => {
      if (name === "plan") {
        const a = action("PLAN_COMPLETED")
        issueState.core.lastOutcome = a
        issueState.core.attempts.plan = (issueState.core.attempts.plan ?? 0) + 1
        issueState.executables.plan = { lastAction: a }
        issueState.core.prUrl = "https://github.com/o/r/pull/42"
        return { exitCode: 0 }
      }
      if (name === "review") {
        const a = action("REVIEW_PASS")
        prState.core.lastOutcome = a
        prState.core.attempts.review = (prState.core.attempts.review ?? 0) + 1
        prState.executables.review = { lastAction: a }
        // issueState.lastOutcome stays at PLAN_COMPLETED — the bug case.
        return { exitCode: 0 }
      }
      return { exitCode: 99 }
    }

    const readTaskState: NonNullable<ExecutorInput["__readTaskState"]> = (target) => {
      const src = target === "pr" ? prState : issueState
      return JSON.parse(JSON.stringify(src)) as TaskState
    }

    const root = makeContainerFixture({
      containerName: "tgt-pr",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "review", "*": "abort" } },
        { exec: "review", target: "pr", next: { REVIEW_PASS: "done", "*": "abort" } },
      ],
    })

    process.chdir(root)
    const result = await runExecutable("tgt-pr", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: runChild,
      __readTaskState: readTaskState,
    })

    expect(result.exitCode).toBe(0)
  })

  it("falls back to the issue thread for a target:'issue' child", async () => {
    // Mirror of above: a target:"issue" child must NOT be routed via the
    // PR thread even when prUrl is set, otherwise a fix→re-run loop would
    // misroute by reading the PR thread's stale review state.
    const issueState = emptyState()
    const prState = emptyState()
    issueState.core.prUrl = "https://github.com/o/r/pull/42"
    // Seed the PR thread with a value that would mis-route if read.
    prState.core.lastOutcome = action("REVIEW_PASS")

    const runChild: NonNullable<ExecutorInput["__runChild"]> = async (name): Promise<ExecutorOutput> => {
      if (name === "again") {
        const a = action("RUN_COMPLETED")
        issueState.core.lastOutcome = a
        issueState.core.attempts.again = (issueState.core.attempts.again ?? 0) + 1
        issueState.executables.again = { lastAction: a }
        return { exitCode: 0 }
      }
      return { exitCode: 99 }
    }

    const readTaskState: NonNullable<ExecutorInput["__readTaskState"]> = (target) => {
      const src = target === "pr" ? prState : issueState
      return JSON.parse(JSON.stringify(src)) as TaskState
    }

    const root = makeContainerFixture({
      containerName: "tgt-issue",
      children: [{ exec: "again", target: "issue", next: { RUN_COMPLETED: "done", "*": "abort" } }],
    })

    process.chdir(root)
    const result = await runExecutable("tgt-issue", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: runChild,
      __readTaskState: readTaskState,
    })

    expect(result.exitCode).toBe(0)
  })
})

describe("container: failure-shape regression suite", () => {
  // These tests reproduce real production failures observed on A-Guy issue
  // #1440 and similar runs. Each test exercises a class of bug that the
  // synthetic happy-path tests above couldn't catch.

  it("synthesizes <EXEC>_FAILED when child exits non-zero without writing a new action", async () => {
    // Reproduces A-Guy #1440: run's preflight (runFlow) exited non-zero
    // without calling saveTaskState (historically via the now-removed
    // UncommittedChangesError refusal). The container then re-read state
    // and saw the prior child's PLAN_COMPLETED still sitting there, routed
    // via wildcard to abort, and finishFlow's RUN_FAILED runWhen never
    // fired — leaving intermediate kody:running on the issue.
    //
    // The fix: when the post-invoke read returns the SAME lastOutcome as
    // pre-invoke (child didn't write), synthesize <EXEC>_COMPLETED or
    // <EXEC>_FAILED from exit code so runWhens can match correctly.
    const root = makeContainerFixture({
      containerName: "noop-bail",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        { exec: "run", target: "issue", next: { RUN_COMPLETED: "done", RUN_FAILED: "abort", "*": "abort" } },
      ],
    })

    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      // run "bails" — exit non-zero but writes nothing to state.
      { exec: "run", onInvoke: () => null, exitCode: 5 },
    ])

    process.chdir(root)
    const result = await runExecutable("noop-bail", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    // BEFORE THE FIX: result.reason matches /PLAN_COMPLETED/ (stale state)
    // AFTER THE FIX: result.reason matches /RUN_FAILED/ (synthesized)
    expect(result.reason).toMatch(/RUN_FAILED/)
    expect(result.reason).not.toMatch(/PLAN_COMPLETED/)
  })

  it("synthesizes <EXEC>_COMPLETED when child exits 0 without writing a new action", async () => {
    // Mirror of the above for the success path. If a child legitimately
    // exits 0 without saveTaskState (e.g. a no-op executable), the
    // container should synthesize <EXEC>_COMPLETED so routing keys match.
    const root = makeContainerFixture({
      containerName: "noop-ok",
      children: [{ exec: "noop", target: "issue", next: { NOOP_COMPLETED: "done", "*": "abort" } }],
    })

    const env = makeMockEnvironment([{ exec: "noop", onInvoke: () => null, exitCode: 0 }])

    process.chdir(root)
    const result = await runExecutable("noop-ok", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(0)
  })

  it("ctx.data.taskState.core.lastOutcome reflects synthesized action so finishFlow runWhens can match", async () => {
    // The whole point of synthesizing the action: postflight scripts (like
    // finishFlow) read core.lastOutcome.type via runWhen and need to see
    // the child's actual failure, not the prior child's success.
    //
    // We can't observe ctx.data directly from runExecutable, but we can
    // verify via the routing decision in the abort reason — if the abort
    // route was taken because of RUN_FAILED, the runWhen system would also
    // see RUN_FAILED.
    const root = makeContainerFixture({
      containerName: "lastoutcome-check",
      children: [
        { exec: "plan", target: "issue", next: { PLAN_COMPLETED: "run", "*": "abort" } },
        // Only RUN_FAILED routes to abort. PLAN_COMPLETED should NOT match
        // because plan already succeeded. If the container leaks the prior
        // PLAN_COMPLETED into run's outcome, this routing fails silently.
        { exec: "run", target: "issue", next: { RUN_FAILED: "abort", RUN_COMPLETED: "done" } },
      ],
    })

    const env = makeMockEnvironment([
      { exec: "plan", onInvoke: () => action("PLAN_COMPLETED") },
      { exec: "run", onInvoke: () => null, exitCode: 1 }, // write nothing, fail
    ])

    process.chdir(root)
    const result = await runExecutable("lastoutcome-check", {
      cliArgs: { issue: 7 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    // run had no "*" route, so the only way the container exits non-zero
    // here is via RUN_FAILED → abort. If the container synthesizes correctly,
    // the abort reason cites RUN_FAILED. If it doesn't, the container
    // crashes with "no route for action PLAN_COMPLETED from child run".
    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/RUN_FAILED/)
    expect(result.reason).not.toMatch(/no route for action/)
  })
})

describe("container: iteration cap", () => {
  it("aborts after 50 iterations on a routing loop", async () => {
    const root = makeContainerFixture({
      containerName: "loop",
      children: [
        { exec: "a", target: "issue", next: { TICK: "b", "*": "abort" } },
        { exec: "b", target: "issue", next: { TICK: "a", "*": "abort" } },
      ],
    })
    const env = makeMockEnvironment([
      { exec: "a", onInvoke: () => action("TICK") },
      { exec: "b", onInvoke: () => action("TICK") },
    ])

    process.chdir(root)
    const result = await runExecutable("loop", {
      cliArgs: { issue: 1 },
      cwd: root,
      skipConfig: true,
      __runChild: env.runChild,
      __readTaskState: env.readTaskState,
    })

    expect(result.exitCode).toBe(1)
    expect(result.reason).toMatch(/exceeded 50 iterations/)
  }, 10_000)
})

// NOTE: the synthetic-action attempts-counter bump (when a child bails
// without writing state) is a one-line fix in src/container.ts that
// defensively bumps core.attempts[child] alongside the synthesized
// lastOutcome. A unit test for it would need to capture ctx.data from a
// postflight, which requires either a production script with a side
// effect or a vi.mock of the postflight catalog that vitest's hoisting
// rules fight. The fix is documented in the code comment; the existing
// test suite + manual tester-repo verification will catch regressions.
