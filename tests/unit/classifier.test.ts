import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadProfile } from "../../src/profile.js"
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
  it("uses a pre-set classification (from classifyByLabel) and records the action — no dispatch comment", async () => {
    const c = ctx({
      data: {
        classification: "bug",
        classificationSource: "label",
        classificationReason: "label `bug` → bug",
      },
    })
    await recordClassification(c, profile(), null)
    const ghBodies = execFileSync.mock.calls
      .map((call) => (call[1] as string[]) ?? [])
      .filter((a) => a[3] === "--body")
      .map((a) => a[4] as string)
    // Audit comment posted, but NOT the dispatch — that's dispatchClassified's job.
    expect(ghBodies.some((b) => b.startsWith("🔎 kody classified as `bug`"))).toBe(true)
    expect(ghBodies.some((b) => b === "@kody bug")).toBe(false)
    expect((c.data.action as { type: string }).type).toBe("CLASSIFIED_AS_BUG")
    expect(c.data.classification).toBe("bug")
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
  it("posts `@kody <classification>` from ctx.data.classification", async () => {
    const c = ctx({ data: { classification: "bug" } })
    await dispatchClassified(c, profile(), null)
    const dispatches = execFileSync.mock.calls
      .map((call) => (call[1] as string[]) ?? [])
      .filter((a) => a[3] === "--body" && a[4]?.startsWith("@kody "))
    expect(dispatches.some((a) => a[4] === "@kody bug")).toBe(true)
  })

  it("is a no-op when no classification was recorded", async () => {
    const c = ctx({ data: {} })
    await dispatchClassified(c, profile(), null)
    expect(execFileSync.mock.calls.length).toBe(0)
  })

  it("is a no-op for an invalid classification value", async () => {
    const c = ctx({ data: { classification: "not-a-real-class" } })
    await dispatchClassified(c, profile(), null)
    expect(execFileSync.mock.calls.length).toBe(0)
  })
})

describe("classify profile loadability", () => {
  it("loads cleanly with the expected script registry + role", () => {
    const EXE_ROOT = path.resolve(__dirname, "../../src/executables")
    const p = loadProfile(path.join(EXE_ROOT, "classify/profile.json"))
    expect(p.name).toBe("classify")
    expect(p.role).toBe("primitive")
    expect(p.inputs.map((i) => i.name)).toEqual(["issue"])
    const pre = p.scripts.preflight.map((e) => e.script)
    expect(pre).toContain("classifyByLabel")
    expect(pre).toContain("loadIssueContext")
    expect(pre).toContain("composePrompt")
    const post = p.scripts.postflight.map((e) => e.script)
    expect(post).toContain("parseAgentResult")
    expect(post).toContain("recordClassification")
    expect(post).toContain("dispatchClassified")
    // dispatchClassified must run AFTER saveTaskState — that ordering is what
    // makes the @kody <type> comment the newest pending issue_comment event.
    const idxSave = post.indexOf("saveTaskState")
    const idxDispatch = post.indexOf("dispatchClassified")
    expect(idxSave).toBeGreaterThan(-1)
    expect(idxDispatch).toBeGreaterThan(idxSave)
    // Sanity: prompt.md exists and references the label block.
    const prompt = fs.readFileSync(path.join(p.dir, "prompt.md"), "utf-8")
    expect(prompt).toContain("{{issue.labelsFormatted}}")
    expect(prompt).toContain("classification:")
  })
})
