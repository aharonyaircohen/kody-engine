import * as childProcess from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { classifyByLabel, defaultLabelMap } from "../../src/scripts/classifyByLabel.js"
import { dispatchClassified } from "../../src/scripts/dispatchClassified.js"
import { parseClassification, recordClassification } from "../../src/scripts/recordClassification.js"

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, execFileSync: vi.fn() }
})

const execFileSync = childProcess.execFileSync as unknown as Mock

function profile(): Profile {
  return {
    name: "classify",
    role: "primitive",
    describe: "",
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
    args: { issue: 99 },
    cwd: "/tmp",
    config: {
      quality: { typecheck: "", lint: "", testUnit: "", format: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      state: { repo: "o/kody-state", path: "r" },
      agent: { model: "claude/claude-haiku-4-5-20251001" },
    },
    data: {},
    output: { exitCode: 0 },
    ...overrides,
  }
}

beforeEach(() => execFileSync.mockReset())
afterEach(() => vi.clearAllMocks())

describe("classifyByLabel", () => {
  it("picks a class from a matching label using the default map", async () => {
    const c = ctx({ data: { issue: { labels: ["bug"] } } })
    await classifyByLabel(c, profile())
    expect(c.data.classification).toBe("bug")
    expect(c.data.classificationSource).toBe("label")
    expect(c.skipAgent).toBe(true)
  })

  it("is case-insensitive on the label name", async () => {
    const c = ctx({ data: { issue: { labels: ["Enhancement"] } } })
    await classifyByLabel(c, profile())
    expect(c.data.classification).toBe("bug") // 'enhancement' maps to 'bug'
    expect(c.skipAgent).toBe(true)
  })

  it("prefers an explicit config.classify.labelMap over the default", async () => {
    const c = ctx({
      data: { issue: { labels: ["wontfix"] } },
      config: {
        ...ctx().config,
        classify: { labelMap: { wontfix: "chore" } },
      } as Context["config"],
    })
    await classifyByLabel(c, profile())
    expect(c.data.classification).toBe("chore")
  })

  it("no-ops when no label matches (agent fallback path)", async () => {
    const c = ctx({ data: { issue: { labels: ["needs-investigation"] } } })
    await classifyByLabel(c, profile())
    expect(c.data.classification).toBeUndefined()
    expect(c.skipAgent).toBeUndefined()
  })

  it("no-ops when the issue has no labels", async () => {
    const c = ctx({ data: { issue: { labels: [] } } })
    await classifyByLabel(c, profile())
    expect(c.skipAgent).toBeUndefined()
  })

  it("rejects a mapped value that isn't a known flow type", async () => {
    const c = ctx({
      data: { issue: { labels: ["weird"] } },
      config: {
        ...ctx().config,
        classify: { labelMap: { weird: "not-a-real-flow" } },
      } as Context["config"],
    })
    await classifyByLabel(c, profile())
    expect(c.data.classification).toBeUndefined()
    expect(c.skipAgent).toBeUndefined()
  })
})

describe("defaultLabelMap", () => {
  it("maps the canonical GitHub labels into flow names", () => {
    const map = defaultLabelMap()
    expect(map.bug).toBe("bug")
    expect(map.enhancement).toBe("bug")
    expect(map.refactor).toBe("feature")
    expect(map.rfc).toBe("spec")
    expect(map.docs).toBe("chore")
  })
})

describe("parseClassification", () => {
  it("extracts class + reason from a well-formed PR_SUMMARY block", () => {
    const body = "classification: feature\nreason: adds a new toggle and tests"
    expect(parseClassification(body)).toEqual({ classification: "feature", reason: "adds a new toggle and tests" })
  })

  it("is case-insensitive on the class token and tolerates leading whitespace", () => {
    expect(parseClassification("  classification:   Bug  \nreason: fix")).toEqual({
      classification: "bug",
      reason: "fix",
    })
  })

  it("returns null for an invalid class", () => {
    expect(parseClassification("classification: blueprint\nreason: …")).toBeNull()
  })

  it("returns null when the header is missing", () => {
    expect(parseClassification("this body has no classification header")).toBeNull()
  })
})

describe("recordClassification", () => {
  it("uses a pre-set classification (from classifyByLabel) and stashes audit text on ctx — no comments posted", async () => {
    const c = ctx({
      data: {
        classification: "bug",
        classificationSource: "label",
        classificationReason: "label `bug` → bug",
      },
    })
    await recordClassification(c, profile(), null)
    // Success path: recordClassification must NOT post any comment or write
    // state. dispatchClassified owns state persistence plus the in-process
    // handoff that avoids the old classify pipeline race.
    expect(execFileSync.mock.calls.length).toBe(0)
    expect((c.data.action as { type: string }).type).toBe("CLASSIFIED_AS_BUG")
    expect(c.data.classification).toBe("bug")
    expect(c.data.classificationAudit).toBe("🔎 kody classified as `bug` — label `bug` → bug")
  })

  it("falls back to parsing the agent's PR_SUMMARY when classifyByLabel didn't set one", async () => {
    const c = ctx({
      data: {
        prSummary: "classification: spec\nreason: pure RFC ask",
      },
    })
    await recordClassification(c, profile(), null)
    expect((c.data.action as { type: string }).type).toBe("CLASSIFIED_AS_SPEC")
    expect(c.data.classification).toBe("spec")
  })

  it("records a CLASSIFY_FAILED action when neither source decides", async () => {
    const c = ctx({ data: { prSummary: "something unrelated" } })
    await recordClassification(c, profile(), null)
    expect((c.data.action as { type: string }).type).toBe("CLASSIFY_FAILED")
    expect(c.output.exitCode).toBe(1)
  })
})

describe("dispatchClassified", () => {
  it("hands the next stage to the orchestrator in-process and persists state to the state repo", async () => {
    execFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh" && Array.isArray(args) && args[0] === "api") {
        const apiPath = args.find((arg) => arg.startsWith("/repos/")) ?? ""
        if (apiPath.endsWith("/git/ref/heads/main")) {
          return JSON.stringify({ object: { sha: "state-branch-sha" } })
        }
        if (args.includes("--method") && args.includes("PUT")) return "{}"
        throw new Error("HTTP 404 Not Found")
      }
      return ""
    })
    const c = ctx({
      data: {
        classification: "bug",
        classificationAudit: "🔎 kody classified as `bug` — label `bug` → bug",
        action: { type: "CLASSIFIED_AS_BUG", payload: {}, timestamp: "2026-05-19T00:00:00.000Z" },
      },
    })
    await dispatchClassified(c, profile(), null)
    // In-process hand-off — NOT a comment round-trip. This is what avoids the
    // bot-author deadlock (a bot-authored `@kody bug` is silently ignored).
    expect(c.output.nextDispatch).toEqual({ action: "bug", cliArgs: { issue: 99 } })

    const puts = execFileSync.mock.calls.filter(
      (call) => call[0] === "gh" && Array.isArray(call[1]) && (call[1] as string[]).includes("PUT"),
    )
    expect(puts.length).toBe(1)
    const args = puts[0]![1] as string[]
    expect(args).toContain("/repos/o/kody-state/contents/r/tasks/issues/99/state.json")
    const payload = JSON.parse((puts[0]![2] as { input?: string }).input ?? "{}") as {
      branch?: string
      content?: string
    }
    expect(payload.branch).toBe("main")
    const stateJson = Buffer.from(payload.content ?? "", "base64").toString("utf-8")
    expect(stateJson).toContain("CLASSIFIED_AS_BUG")
    expect(stateJson).not.toContain("@kody")
  })

  it("is a no-op when no classification was recorded", async () => {
    const c = ctx({ data: {} })
    await dispatchClassified(c, profile(), null)
    expect(execFileSync.mock.calls.length).toBe(0)
    expect(c.output.nextDispatch).toBeUndefined()
  })

  it("is a no-op for an invalid classification value", async () => {
    const c = ctx({ data: { classification: "not-a-real-class" } })
    await dispatchClassified(c, profile(), null)
    expect(execFileSync.mock.calls.length).toBe(0)
    expect(c.output.nextDispatch).toBeUndefined()
  })

  it("is a no-op when classification is set but action is missing", async () => {
    const c = ctx({ data: { classification: "bug" } })
    await dispatchClassified(c, profile(), null)
    expect(execFileSync.mock.calls.length).toBe(0)
    expect(c.output.nextDispatch).toBeUndefined()
  })
})
