import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { autoDispatch } from "../../src/dispatch.js"

function writeEvent(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-dispatch-"))
  const p = path.join(dir, "event.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

describe("dispatch: explicit override", () => {
  it("routes to run when issueNumber provided", () => {
    const r = autoDispatch({ explicit: { issueNumber: 42 } })
    expect(r).toEqual({
      executable: "run",
      cliArgs: { issue: 42 },
      target: 42,
    })
  })

  it("returns null when issueNumber is 0 and no event", () => {
    const prev = process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_EVENT_NAME
    expect(autoDispatch({ explicit: { issueNumber: 0 } })).toBeNull()
    if (prev) process.env.GITHUB_EVENT_NAME = prev
  })
})

describe("dispatch: workflow_dispatch event", () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
  })

  it("routes issue_number input to run", () => {
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({ inputs: { issue_number: "17" } })
    expect(autoDispatch()).toEqual({
      executable: "run",
      cliArgs: { issue: 17 },
      target: 17,
    })
  })

  it("returns null when issue_number is missing", () => {
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({ inputs: {} })
    expect(autoDispatch()).toBeNull()
  })
})

describe("dispatch: issue_comment on issue", () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "issue_comment"
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
  })

  it("routes '@kody2 plan' to plan executable", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 plan" },
      issue: { number: 7 },
    })
    expect(autoDispatch()).toEqual({
      executable: "plan",
      cliArgs: { issue: 7 },
      target: 7,
    })
  })

  it("routes '@kody2 run' to run executable", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 run" },
      issue: { number: 8 },
    })
    expect(autoDispatch()).toEqual({
      executable: "run",
      cliArgs: { issue: 8 },
      target: 8,
    })
  })

  it("routes legacy '@kody2 build' → run (backward-compat)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 build" },
      issue: { number: 15 },
    })
    expect(autoDispatch()).toEqual({
      executable: "run",
      cliArgs: { issue: 15 },
      target: 15,
    })
  })

  it("routes '@kody2 bug' to the bug sub-orchestrator", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 bug" },
      issue: { number: 9 },
    })
    expect(autoDispatch()).toEqual({
      executable: "bug",
      cliArgs: { issue: 9 },
      target: 9,
    })
  })

  it("legacy '@kody2 orchestrate' maps to the `bug` sub-orchestrator", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 orchestrate" },
      issue: { number: 10 },
    })
    expect(autoDispatch()?.executable).toBe("bug")
  })

  it("legacy '@kody2 orchestrator' (alias) also maps to `bug`", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 orchestrator" },
      issue: { number: 11 },
    })
    expect(autoDispatch()?.executable).toBe("bug")
  })

  it("routes '@kody2 feature' via generic pass-through", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 feature" },
      issue: { number: 21 },
    })
    expect(autoDispatch()).toEqual({
      executable: "feature",
      cliArgs: { issue: 21 },
      target: 21,
    })
  })

  it("generic pass-through: '@kody2 custom-exec' → custom-exec", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 custom-exec" },
      issue: { number: 11 },
    })
    expect(autoDispatch()).toEqual({
      executable: "custom-exec",
      cliArgs: { issue: 11 },
      target: 11,
    })
  })

  it("bare '@kody2' falls back to config.defaultExecutable", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2" },
      issue: { number: 12 },
    })
    expect(
      autoDispatch({
        config: { defaultExecutable: "orchestrator" } as any,
      }),
    ).toEqual({
      executable: "orchestrator",
      cliArgs: { issue: 12 },
      target: 12,
    })
  })

  it("bare '@kody2' with no config defaults to run", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2" },
      issue: { number: 13 },
    })
    expect(autoDispatch()).toEqual({
      executable: "run",
      cliArgs: { issue: 13 },
      target: 13,
    })
  })

  it("ignores case in '@KoDy2 PLAN'", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@KoDy2 PLAN" },
      issue: { number: 14 },
    })
    expect(autoDispatch()?.executable).toBe("plan")
  })
})

describe("dispatch: issue_comment on PR", () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "issue_comment"
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
  })

  it("'@kody2 fix-ci' on PR → fix-ci", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 fix-ci" },
      issue: { number: 20, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      executable: "fix-ci",
      cliArgs: { pr: 20 },
      target: 20,
    })
  })

  it("'@kody2 resolve' on PR → resolve", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 resolve" },
      issue: { number: 21, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      executable: "resolve",
      cliArgs: { pr: 21 },
      target: 21,
    })
  })

  it("'@kody2 review' on PR → review", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 review" },
      issue: { number: 24, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      executable: "review",
      cliArgs: { pr: 24 },
      target: 24,
    })
  })

  it("'@kody2 ui-review' on PR → ui-review (not review)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 ui-review" },
      issue: { number: 77, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      executable: "ui-review",
      cliArgs: { pr: 77 },
      target: 77,
    })
  })

  it("'@kody2 ui-review please check login' on PR → ui-review (prefix win, feedback ignored)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 ui-review please check login" },
      issue: { number: 78, pull_request: {} },
    })
    const r = autoDispatch()
    expect(r?.executable).toBe("ui-review")
    expect(r?.cliArgs.pr).toBe(78)
  })

  it("'@kody2 sync' on PR → sync", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 sync" },
      issue: { number: 25, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      executable: "sync",
      cliArgs: { pr: 25 },
      target: 25,
    })
  })

  it("'@kody2 please change foo' on PR → fix with feedback", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 please change foo" },
      issue: { number: 22, pull_request: {} },
    })
    const r = autoDispatch()
    expect(r?.executable).toBe("fix")
    expect(r?.cliArgs.pr).toBe(22)
    expect(r?.cliArgs.feedback).toContain("change foo")
  })

  it("bare '@kody2' on PR → fix without feedback", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2" },
      issue: { number: 23, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      executable: "fix",
      cliArgs: { pr: 23 },
      target: 23,
    })
  })

  it("bare '@kody2 fix' on PR → fix WITHOUT inline feedback (reads PR review)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 fix" },
      issue: { number: 24, pull_request: {} },
    })
    const r = autoDispatch()
    expect(r?.executable).toBe("fix")
    expect(r?.cliArgs.pr).toBe(24)
    expect(r?.cliArgs.feedback).toBeUndefined()
  })

  it("'@kody2 fix: address instructor.name' on PR → fix with inline feedback", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody2 fix: address the instructor.name concern" },
      issue: { number: 25, pull_request: {} },
    })
    const r = autoDispatch()
    expect(r?.executable).toBe("fix")
    expect(r?.cliArgs.feedback).toBe("address the instructor.name concern")
  })
})

describe("dispatch: defensive cases", () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
  })

  it("returns null for unrecognized event", () => {
    process.env.GITHUB_EVENT_NAME = "push"
    process.env.GITHUB_EVENT_PATH = writeEvent({})
    expect(autoDispatch()).toBeNull()
  })

  it("returns null when EVENT_PATH does not exist", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = "/tmp/nonexistent-kody2-event.json"
    expect(autoDispatch()).toBeNull()
  })

  it("returns null when no environment is set", () => {
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_EVENT_PATH
    expect(autoDispatch()).toBeNull()
  })
})
