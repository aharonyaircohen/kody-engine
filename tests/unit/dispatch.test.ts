import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { autoDispatch } from "../../src/dispatch.js"

function writeEvent(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-"))
  const p = path.join(dir, "event.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

function testConfig(config: Partial<KodyConfig>): KodyConfig {
  return config as KodyConfig
}

function writeSeparatedAsset(
  root: string,
  name: string,
  runtime: Record<string, unknown>,
  options: { action?: string; implementationId?: string } = {},
): void {
  const implementationId = options.implementationId ?? name
  const capability = {
    id: name,
    action: options.action ?? name,
    purpose: String(runtime.describe ?? name),
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    effects: [],
    permissions: [],
    success: "success",
    failure: "failure",
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",")}}`
    }
    return JSON.stringify(value)
  }
  const capabilityDir = path.join(root, ".kody-engine", "definitions", "capabilities", name)
  const implementationDir = path.join(root, ".kody-engine", "definitions", "implementations", implementationId)
  fs.mkdirSync(capabilityDir, { recursive: true })
  fs.mkdirSync(implementationDir, { recursive: true })
  fs.writeFileSync(path.join(capabilityDir, "definition.json"), JSON.stringify(capability))
  fs.writeFileSync(path.join(capabilityDir, "capability.md"), `# ${name}\n`)
  fs.writeFileSync(
    path.join(implementationDir, "definition.json"),
    JSON.stringify({
      id: implementationId,
      capabilityRef: { kind: "capability", id: name },
      compatibleCapabilityRevision: createHash("sha256").update(canonical(capability)).digest("hex"),
      type: "agent",
      agentRef: { kind: "agent", id: "kody" },
    }),
  )
  fs.writeFileSync(
    path.join(implementationDir, "runtime.json"),
    JSON.stringify({
      adapter: "kody-engine-profile",
      inputBindings: {},
      outputBindings: {},
      requirements: {},
      name: implementationId,
      ...runtime,
    }),
  )
}

function writeLocalReleaseAsset(root: string): void {
  writeSeparatedAsset(root, "release", {
    action: "release",
    role: "primitive",
    describe: "Run release flow.",
    inputs: [
      { name: "issue", flag: "--issue", type: "int", required: true, describe: "Release issue number." },
      { name: "bump", flag: "--bump", type: "enum", values: ["patch", "minor", "major"], describe: "Version bump." },
    ],
    claudeCode: {
      model: "inherit",
      permissionMode: "acceptEdits",
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
  })
}

function writeLocalInputlessAsset(root: string, name: string): void {
  writeSeparatedAsset(root, name, {
    action: name,
    role: "primitive",
    describe: "Run without a numeric target input.",
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
  })
}

describe("dispatch: explicit override", () => {
  it("routes to run when issueNumber provided", () => {
    const r = autoDispatch({ explicit: { issueNumber: 42 } })
    expect(r).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
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
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 17 },
      target: 17,
    })
  })

  it("routes capability + base inputs to that capability action with --base", () => {
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      inputs: { issue_number: "42", capability: "run", base: "11-x" },
    })
    expect(autoDispatch()).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 42, base: "11-x" },
      target: 42,
    })
  })

  it("routes workflow_dispatch capability=release to release implementation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-release-workflow-"))
    const prevCwd = process.cwd()
    try {
      process.chdir(tmp)
      writeLocalReleaseAsset(tmp)
      process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
      process.env.GITHUB_EVENT_PATH = writeEvent({
        inputs: { issue_number: "291", capability: "release" },
      })
      expect(autoDispatch()).toEqual({
        action: "release",
        capability: "release",
        implementation: "release",
        cliArgs: { issue: 291 },
        target: 291,
      })
    } finally {
      process.chdir(prevCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("keeps issue_number as routing context when the capability declares no numeric input", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-inputless-workflow-"))
    const prevCwd = process.cwd()
    try {
      process.chdir(tmp)
      writeLocalInputlessAsset(tmp, "health-check")
      process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
      process.env.GITHUB_EVENT_PATH = writeEvent({
        inputs: { issue_number: "3813", capability: "health-check", base: "main" },
      })
      expect(autoDispatch()).toEqual({
        action: "health-check",
        capability: "health-check",
        implementation: "health-check",
        cliArgs: {},
        target: 3813,
      })
    } finally {
      process.chdir(prevCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("ignores removed legacy workflow_dispatch implementation input and falls back to run", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-release-workflow-"))
    const prevCwd = process.cwd()
    try {
      process.chdir(tmp)
      writeLocalReleaseAsset(tmp)
      process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
      process.env.GITHUB_EVENT_PATH = writeEvent({
        inputs: { issue_number: "291", implementation: "release" },
      })
      expect(autoDispatch()).toEqual({
        action: "run",
        capability: "run",
        implementation: "run",
        cliArgs: { issue: 291 },
        target: 291,
      })
    } finally {
      process.chdir(prevCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("returns null for workflow_dispatch with no issue_number — caller fans out via dispatchScheduledWatches(force)", () => {
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch"
    process.env.GITHUB_EVENT_PATH = writeEvent({ inputs: {} })
    expect(autoDispatch()).toBeNull()
  })
})

describe("dispatch: schedule event", () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
  })

  it("returns null for schedule events — caller fans out via dispatchScheduledWatches", () => {
    process.env.GITHUB_EVENT_NAME = "schedule"
    process.env.GITHUB_EVENT_PATH = writeEvent({ schedule: "*/5 * * * *" })
    expect(autoDispatch()).toBeNull()
  })
})

describe("dispatch: pull_request event", () => {
  const prev: Record<string, string | undefined> = {}
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "pull_request"
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
  })

  it("returns null when onPullRequest is unset (default — PR events do nothing)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({ action: "opened", number: 7, pull_request: { number: 7 } })
    expect(autoDispatch()).toBeNull()
  })

  it("routes an opened PR to onPullRequest, binding the number under the target's int input", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({ action: "opened", number: 7, pull_request: { number: 7 } })
    expect(autoDispatch({ config: testConfig({ onPullRequest: "preview-build" }) })).toEqual({
      action: "preview-build",
      capability: "preview-build",
      implementation: "preview-build",
      cliArgs: { pr: 7 },
      target: 7,
    })
  })

  it("routes a synchronize (new commit) PR to onPullRequest", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({ action: "synchronize", number: 9, pull_request: { number: 9 } })
    expect(autoDispatch({ config: testConfig({ onPullRequest: "preview-build" }) })).toEqual({
      action: "preview-build",
      capability: "preview-build",
      implementation: "preview-build",
      cliArgs: { pr: 9 },
      target: 9,
    })
  })

  it("does not route release PRs to the generic pull_request preview action", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "opened",
      number: 12,
      pull_request: { number: 12, head: { ref: "release/v0.26.7" } },
    })
    expect(autoDispatch({ config: testConfig({ onPullRequest: "preview-build" }) })).toBeNull()
  })

  it("does not route release promotion PRs to the generic pull_request preview action", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "synchronize",
      number: 13,
      pull_request: {
        number: 13,
        head: { ref: "dev" },
        base: { ref: "main" },
      },
    })
    expect(
      autoDispatch({
        config: testConfig({
          git: { defaultBranch: "dev" },
          release: { releaseBranch: "main" },
          onPullRequest: "preview-build",
        }),
      }),
    ).toBeNull()
  })

  it("ignores closed/merged PRs even when onPullRequest is set (release self-manages its merge)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      action: "closed",
      number: 11,
      pull_request: { number: 11, merged: true },
    })
    expect(autoDispatch({ config: testConfig({ onPullRequest: "preview-build" }) })).toBeNull()
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

  it("routes '@kody run' to the run capability", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody run" },
      issue: { number: 8 },
    })
    expect(autoDispatch()).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 8 },
      target: 8,
    })
  })

  it("ignores a bare @kody substring inside an email (no real mention) → null", () => {
    // Regression (#5): the gate was `.includes("@kody")`, so an email like
    // `me@kody.dev` launched the default capability action on an unrelated comment.
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "ping me@kody.dev when this is ready" },
      issue: { number: 8 },
    })
    expect(autoDispatch()).toBeNull()
  })

  it("ignores '@kodyfix' (no boundary after @kody) → null", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kodyfix please" },
      issue: { number: 8 },
    })
    expect(autoDispatch()).toBeNull()
  })

  it("ignores the App's own '@kodyade[bot]' username mention → null", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "cc @kodyade[bot] fix this" },
      issue: { number: 8 },
    })
    expect(autoDispatch()).toBeNull()
  })

  it("matches a real @kody mention mid-sentence (after whitespace)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "please @kody run this now" },
      issue: { number: 9 },
    })
    // "this now" is free text no input captured → carried as the job's `why`.
    expect(autoDispatch()).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 9 },
      target: 9,
      why: "this now",
    })
  })

  it("routes '@kody <action>' through a capability action, not a bare implementation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-action-dispatch-"))
    const prevCwd = process.cwd()
    try {
      process.chdir(tmp)
      writeSeparatedAsset(
        tmp,
        "remember",
        {
          role: "utility",
          describe: "Custom implementation.",
          inputs: [{ name: "issue", flag: "--issue", type: "int", required: true }],
        },
        { implementationId: "custom-impl" },
      )
      process.env.GITHUB_EVENT_PATH = writeEvent({
        comment: { body: "@kody remember" },
        issue: { number: 12 },
      })

      expect(autoDispatch()).toEqual({
        action: "remember",
        capability: "remember",
        implementation: "custom-impl",
        cliArgs: { issue: 12 },
        target: 12,
      })
    } finally {
      process.chdir(prevCwd)
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("routes legacy '@kody build' → run (backward-compat)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody build" },
      issue: { number: 15 },
    })
    expect(autoDispatch()).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 15 },
      target: 15,
    })
  })

  it("unknown subcommand returns null even when defaultImplementation is set (typo guard)", () => {
    // Behavior changed in 0.4.36: a typed-but-unrecognized subcommand no
    // longer silently routes to the default capability action. The kody-cli typed
    // wrapper (autoDispatchTyped) now classifies these as `unrecognized`
    // and posts a feedback comment back to the user. This was the bug
    // behind A-Guy-educ/A-Guy issue #1545: `@kody feature` ended up at
    // the configured `classify` default with no signal of what happened.
    // Natural-language openings (`@kody please ...`) still fall through —
    // see POLITE_WORDS in dispatch.ts.
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody custom-exec" },
      issue: { number: 11 },
    })
    expect(
      autoDispatch({
        config: testConfig({ defaultImplementation: "classify" }),
      }),
    ).toBeNull()
  })

  it("preserves `--flag value` when no subcommand precedes it", () => {
    // Regression: extractCommentRest's old `^[\s:,.-]+` strip ate the
    // leading `--` of a flag-first comment, so parseCommentArgs saw
    // `base dev` instead of `--base dev` and never set args.base.
    // safe base override dispatch may post `@kody --base <branch>` —
    // dropping --base collapses the stack onto the repo default.
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody --base 3293-stacked-test-1" },
      issue: { number: 42 },
    })
    expect(
      autoDispatch({
        config: testConfig({ defaultImplementation: "run" }),
      }),
    ).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 42, base: "3293-stacked-test-1" },
      target: 42,
    })
  })

  it("falls back to defaultImplementation for `@kody` alone (no typo to surface)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody" },
      issue: { number: 11 },
    })
    expect(
      autoDispatch({
        config: testConfig({ defaultImplementation: "run" }),
      }),
    ).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 11 },
      target: 11,
    })
  })

  it("falls back to defaultImplementation for natural-language openings (please/kindly/...)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody please fix the failing test" },
      issue: { number: 11 },
    })
    expect(
      autoDispatch({
        config: testConfig({ defaultImplementation: "run" }),
      }),
    ).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 11 },
      target: 11,
      // The natural-language remainder (politeness stripped) becomes `why`.
      why: "fix the failing test",
    })
  })

  it("unknown subcommand with no default capability action returns null", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody custom-exec" },
      issue: { number: 11 },
    })
    expect(autoDispatch()).toBeNull()
  })

  it("bare '@kody' falls back to the defaultImplementation action", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody" },
      issue: { number: 12 },
    })
    expect(
      autoDispatch({
        config: testConfig({ defaultImplementation: "run" }),
      }),
    ).toEqual({
      action: "run",
      capability: "run",
      implementation: "run",
      cliArgs: { issue: 12 },
      target: 12,
    })
  })

  it("bare '@kody' with no config returns null (config layer owns the default)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody" },
      issue: { number: 13 },
    })
    expect(autoDispatch()).toBeNull()
  })

  it("ignores case in '@KoDy RUN'", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@KoDy RUN" },
      issue: { number: 14 },
    })
    expect(autoDispatch()?.implementation).toBe("run")
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

  it("'@kody fix-ci' on PR → fix-ci", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix-ci" },
      issue: { number: 20, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "fix-ci",
      capability: "fix-ci",
      implementation: "fix-ci",
      cliArgs: { pr: 20 },
      target: 20,
    })
  })

  it("'@kody fix-ci --run-id 123456' parses run-id", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix-ci --run-id 123456" },
      issue: { number: 21, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "fix-ci",
      capability: "fix-ci",
      implementation: "fix-ci",
      cliArgs: { pr: 21, runId: "123456" },
      target: 21,
    })
  })

  it("'@kody resolve' on PR → resolve", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody resolve" },
      issue: { number: 21, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "resolve",
      capability: "resolve",
      implementation: "resolve",
      cliArgs: { pr: 21 },
      target: 21,
    })
  })

  it("'@kody resolve --prefer ours' parses prefer flag", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody resolve --prefer ours" },
      issue: { number: 22, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "resolve",
      capability: "resolve",
      implementation: "resolve",
      cliArgs: { pr: 22, prefer: "ours" },
      target: 22,
    })
  })

  it("'@kody resolve theirs' binds bare enum value to prefer", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody resolve theirs" },
      issue: { number: 23, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "resolve",
      capability: "resolve",
      implementation: "resolve",
      cliArgs: { pr: 23, prefer: "theirs" },
      target: 23,
    })
  })

  it("'@kody sync' on PR → sync", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody sync" },
      issue: { number: 25, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "sync",
      capability: "sync",
      implementation: "sync",
      cliArgs: { pr: 25 },
      target: 25,
    })
  })

  it("bare '@kody fix' on PR → fix without inline feedback", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix" },
      issue: { number: 24, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "fix",
      capability: "fix",
      implementation: "fix",
      cliArgs: { pr: 24 },
      target: 24,
    })
  })

  it("'@kody fix: address reviewer feedback' on PR → fix with inline feedback", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody fix: address reviewer feedback" },
      issue: { number: 25, pull_request: {} },
    })
    expect(autoDispatch()).toEqual({
      action: "fix",
      capability: "fix",
      implementation: "fix",
      cliArgs: { pr: 25, feedback: "address reviewer feedback" },
      target: 25,
    })
  })

  it("bare '@kody' on PR returns null when no PR default is configured", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody" },
      issue: { number: 23, pull_request: {} },
    })
    expect(autoDispatch()).toBeNull()
  })

  it("bare '@kody' on PR falls back to the defaultPrImplementation action", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody" },
      issue: { number: 23, pull_request: {} },
    })
    expect(autoDispatch({ config: testConfig({ defaultPrImplementation: "sync" }) })).toEqual({
      action: "sync",
      capability: "sync",
      implementation: "sync",
      cliArgs: { pr: 23 },
      target: 23,
    })
  })
})

describe("dispatch: release orchestrator + sibling primitives", () => {
  const prev: Record<string, string | undefined> = {}
  let tmp: string
  let prevCwd: string
  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    // Release now lives in project/store assets, not engine built-ins.
    // Install a minimal local asset so these tests stay focused on dispatch.
    prevCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-dispatch-release-"))
    process.chdir(tmp)
    writeLocalReleaseAsset(tmp)
    for (const slug of ["release-prepare", "release-publish", "release-promote"]) {
      fs.cpSync(
        path.join(process.env.KODY_DEFINITIONS_ROOT!, "capabilities", slug),
        path.join(tmp, ".kody-engine", "definitions", "capabilities", slug),
        { recursive: true },
      )
      fs.cpSync(
        path.join(process.env.KODY_DEFINITIONS_ROOT!, "implementations", slug),
        path.join(tmp, ".kody-engine", "definitions", "implementations", slug),
        { recursive: true },
      )
    }
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
    process.chdir(prevCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("'@kody release' routes to the orchestrator with the triggering issue injected", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release" },
      issue: { number: 30 },
    })
    expect(autoDispatch()).toEqual({
      action: "release",
      capability: "release",
      implementation: "release",
      cliArgs: { issue: 30 },
      target: 30,
    })
  })

  it("'@kody release-prepare' routes to release-prepare with the triggering issue", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-prepare" },
      issue: { number: 31 },
    })
    expect(autoDispatch()).toEqual({
      action: "release-prepare",
      capability: "release-prepare",
      implementation: "release-prepare",
      cliArgs: { issue: 31 },
      target: 31,
    })
  })

  it("'@kody release-prepare minor' parses bump from comment text", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-prepare minor" },
      issue: { number: 32 },
    })
    expect(autoDispatch()).toEqual({
      action: "release-prepare",
      capability: "release-prepare",
      implementation: "release-prepare",
      cliArgs: { issue: 32, bump: "minor" },
      target: 32,
    })
  })

  it("'@kody release-prepare --prefer ours' parses prefer via flag form", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-prepare --prefer ours" },
      issue: { number: 40 },
    })
    expect(autoDispatch()).toEqual({
      action: "release-prepare",
      capability: "release-prepare",
      implementation: "release-prepare",
      cliArgs: { issue: 40, prefer: "ours" },
      target: 40,
    })
  })

  it("'@kody release-prepare prefer theirs' parses prefer via bare-flag+value", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-prepare prefer theirs" },
      issue: { number: 41 },
    })
    const r = autoDispatch()
    expect(r?.implementation).toBe("release-prepare")
    expect(r?.action).toBe("release-prepare")
    expect(r?.capability).toBe("release-prepare")
    expect(r?.cliArgs.prefer).toBe("theirs")
    expect(r?.cliArgs.issue).toBe(41)
  })

  it("'@kody release-prepare patch dry-run' combines bump enum + bool keyword", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-prepare patch dry-run" },
      issue: { number: 42 },
    })
    expect(autoDispatch()).toEqual({
      action: "release-prepare",
      capability: "release-prepare",
      implementation: "release-prepare",
      cliArgs: { issue: 42, bump: "patch", "dry-run": true },
      target: 42,
    })
  })

  it("'@kody release-publish' routes to release-publish with the triggering issue", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-publish" },
      issue: { number: 50 },
    })
    expect(autoDispatch()).toEqual({
      action: "release-publish",
      capability: "release-publish",
      implementation: "release-publish",
      cliArgs: { issue: 50 },
      target: 50,
    })
  })

  it("'@kody release-promote' routes to release-promote with the triggering issue", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release-promote" },
      issue: { number: 51 },
    })
    expect(autoDispatch()).toEqual({
      action: "release-promote",
      capability: "release-promote",
      implementation: "release-promote",
      cliArgs: { issue: 51 },
      target: 51,
    })
  })

  it("'@kody release minor' parses bump enum (release implementation declares it after the merged-flow refactor)", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody release minor" },
      issue: { number: 33 },
    })
    expect(autoDispatch()).toEqual({
      action: "release",
      capability: "release",
      implementation: "release",
      cliArgs: { issue: 33, bump: "minor" },
      target: 33,
    })
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
    process.env.GITHUB_EVENT_PATH = "/tmp/nonexistent-kody-event.json"
    expect(autoDispatch()).toBeNull()
  })

  it("returns null when no environment is set", () => {
    delete process.env.GITHUB_EVENT_NAME
    delete process.env.GITHUB_EVENT_PATH
    expect(autoDispatch()).toBeNull()
  })
})

describe("dispatch: alias misconfig surfacing", () => {
  const prev: Record<string, string | undefined> = {}
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    prev.EVENT_NAME = process.env.GITHUB_EVENT_NAME
    prev.EVENT_PATH = process.env.GITHUB_EVENT_PATH
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })
  afterEach(() => {
    process.env.GITHUB_EVENT_NAME = prev.EVENT_NAME
    process.env.GITHUB_EVENT_PATH = prev.EVENT_PATH
    stderrSpy.mockRestore()
  })

  it("warns when a configured alias maps to a non-registered implementation", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      issue: { number: 9, pull_request: null },
      comment: { body: "@kody phantom-cmd", user: { login: "alice", type: "User" } },
    })
    const result = autoDispatch({
      config: {
        aliases: { "phantom-cmd": "no-such-implementation" },
        defaultImplementation: "classify",
      } as never,
    })
    // Behavior changed in 0.4.36: typed-but-unrecognized tokens no longer
    // fall through to the default — the typed wrapper surfaces them to
    // the user instead. The alias-misconfig warning still fires.
    expect(result).toBeNull()
    const warnings = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")
    expect(warnings).toMatch(/alias 'phantom-cmd' → 'no-such-implementation'/)
    expect(warnings).toMatch(/has no matching capability action/)
  })

  it("logs the no-capability-action-resolved breadcrumb for any unrecognized token", () => {
    // Behavior changed in 0.4.36: the breadcrumb fires whenever firstToken
    // is set but no capability action resolves, so consumers (kody-cli) can
    // distinguish "user typed a typo" from "no @kody mention." The
    // breadcrumb itself is the diagnostic; the typed wrapper turns it
    // into user-facing feedback.
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      issue: { number: 9, pull_request: null },
      comment: { body: "@kody totally-unknown-thing", user: { login: "alice", type: "User" } },
    })
    autoDispatch({
      config: { defaultImplementation: "classify", aliases: {} } as never,
    })
    const warnings = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")
    expect(warnings).toMatch(/no capability action resolved/)
    expect(warnings).toMatch(/firstToken=totally-unknown-thing/)
  })

  it("does NOT warn for politeness words like 'please'", () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      issue: { number: 22, pull_request: {} },
      comment: { body: "@kody please change foo", user: { login: "alice", type: "User" } },
    })
    autoDispatch()
    expect(stderrSpy.mock.calls.length).toBe(0)
  })
})

describe("dispatch: comment casing preserved", () => {
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

  it("keeps the operator's casing in flag values and why", () => {
    // Regression: the whole body was lowercased before parsing, so
    // `--base Feature/API-v2` checked out a nonexistent branch and the
    // "verbatim" why reached the agent mangled.
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@kody run --base Feature/API-v2 Fix the OAuth redirect on MyComponent" },
      issue: { number: 12 },
    })
    const r = autoDispatch()
    expect(r?.cliArgs).toEqual({ issue: 12, base: "Feature/API-v2" })
    expect(r?.why).toBe("Fix the OAuth redirect on MyComponent")
  })

  it("still recognizes mention, subcommand, and flags case-insensitively", () => {
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: { body: "@Kody RUN --Base Hotfix/X" },
      issue: { number: 13 },
    })
    const r = autoDispatch()
    expect(r?.action).toBe("run")
    expect(r?.cliArgs).toEqual({ issue: 13, base: "Hotfix/X" })
  })
})
