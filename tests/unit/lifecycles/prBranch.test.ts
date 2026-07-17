import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, ProfileError } from "../../../src/profile.js"

function writeProfile(profile: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-lifecycle-"))
  const p = path.join(dir, "profile.json")
  fs.writeFileSync(p, JSON.stringify(profile))
  return p
}

function baseProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "test-exec",
    role: "primitive",
    describe: "",
    inputs: [],
    claudeCode: { tools: ["Read"] },
    scripts: { preflight: [], postflight: [] },
    ...overrides,
  }
}

describe('lifecycle: "pr-branch"', () => {
  it("wraps profile preflight with sync + label, then context bundle + composePrompt", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abcdef", description: "test label" },
        },
        scripts: {
          preflight: [{ script: "fixFlow" }],
          postflight: [],
        },
      }),
    )

    const profile = loadProfile(p)
    const pre = profile.scripts.preflight.map((e) => e.script)
    expect(pre).toEqual([
      "syncFlow",
      "setLifecycleLabel",
      "fixFlow",
      "loadTaskState",
      "loadConventions",
      "loadPriorArt",
      "loadMemoryContext",
      "loadCoverageRules",
      "composePrompt",
    ])

    const label = profile.scripts.preflight.find((e) => e.script === "setLifecycleLabel")?.with
    expect(label).toEqual({ label: "kody:test", color: "abcdef", description: "test label" })
  })

  it("wraps profile postflight with parseAgentResult + canonical tail", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: { label: { name: "kody:test", color: "abc123", description: "x" } },
        scripts: {
          preflight: [],
          postflight: [{ script: "requireFeedbackActions" }],
        },
      }),
    )

    const profile = loadProfile(p)
    const post = profile.scripts.postflight.map((e) => e.script)
    expect(post).toEqual([
      "parseAgentResult",
      "requireFeedbackActions",
      "verifyWithRetry",
      "checkCoverageWithRetry",
      "abortUnfinishedGitOps",
      "commitAndPush",
      "requireDeliveryArtifacts",
      "ensurePr",
      "postIssueComment",
      "writeAgentRunSummary",
      "saveTaskState",
      "advanceFlow",
    ])
  })

  it('context: "minimal" skips the task-context bundle', () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          context: "minimal",
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )

    const profile = loadProfile(p)
    const pre = profile.scripts.preflight.map((e) => e.script)
    expect(pre).toEqual(["syncFlow", "setLifecycleLabel", "composePrompt"])
  })

  it("rejects missing lifecycleConfig", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(/lifecycleConfig.*label/)
  })

  it("rejects missing label.name", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: { label: { color: "abc123", description: "x" } },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(/label\.name/)
  })

  it("rejects invalid context value", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          context: "whatever",
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(/context must be one of/)
  })

  it("rejects unknown lifecycle name", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "nonexistent",
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(/unknown "lifecycle"/)
  })

  it("rejects lifecycleConfig without lifecycle", () => {
    const p = writeProfile(
      baseProfile({
        lifecycleConfig: { label: { name: "x", color: "y", description: "z" } },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(/only meaningful when "lifecycle" is set/)
  })

  it("propagates errors as ProfileError", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(ProfileError)
  })
})

describe('lifecycle: "pr-branch" — config knobs', () => {
  it("sync: false omits syncFlow from preflight", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          sync: false,
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    const pre = loadProfile(p).scripts.preflight.map((e) => e.script)
    expect(pre).not.toContain("syncFlow")
    expect(pre[0]).toBe("setLifecycleLabel")
  })

  it("verify: false omits verify chain from postflight", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          verify: false,
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    const post = loadProfile(p).scripts.postflight.map((e) => e.script)
    expect(post).not.toContain("verifyWithRetry")
    expect(post).not.toContain("checkCoverageWithRetry")
    expect(post).not.toContain("abortUnfinishedGitOps")
    expect(post).toContain("commitAndPush")
  })

  it("advance: false omits advanceFlow from postflight", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          advance: false,
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    const post = loadProfile(p).scripts.postflight.map((e) => e.script)
    expect(post).not.toContain("advanceFlow")
    expect(post.at(-1)).toBe("saveTaskState")
  })

  it("mirrorState: true adds mirrorStateToPr between saveTaskState and advanceFlow", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          mirrorState: true,
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    const post = loadProfile(p).scripts.postflight.map((e) => e.script)
    const save = post.indexOf("saveTaskState")
    const mirror = post.indexOf("mirrorStateToPr")
    const advance = post.indexOf("advanceFlow")
    expect(mirror).toBeGreaterThan(save)
    expect(advance).toBeGreaterThan(mirror)
  })

  it('context: "ci-fix" loads lean bundle (no priorArt, no memory)', () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          context: "ci-fix",
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    const pre = loadProfile(p).scripts.preflight.map((e) => e.script)
    expect(pre).toContain("loadTaskState")
    expect(pre).toContain("loadConventions")
    expect(pre).toContain("loadCoverageRules")
    expect(pre).not.toContain("loadPriorArt")
    expect(pre).not.toContain("loadMemoryContext")
  })

  it("contextExtras: inserts scripts after loadTaskState", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          contextExtras: ["resolveArtifacts"],
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    const pre = loadProfile(p).scripts.preflight.map((e) => e.script)
    const loadIdx = pre.indexOf("loadTaskState")
    const resolveIdx = pre.indexOf("resolveArtifacts")
    expect(resolveIdx).toBe(loadIdx + 1)
  })

  it("contextExtras rejects non-string items", () => {
    const p = writeProfile(
      baseProfile({
        lifecycle: "pr-branch",
        lifecycleConfig: {
          label: { name: "kody:test", color: "abc123", description: "x" },
          contextExtras: ["valid", 42],
        },
        scripts: { preflight: [], postflight: [] },
      }),
    )
    expect(() => loadProfile(p)).toThrow(/contextExtras must be an array of non-empty strings/)
  })

  it("rejects non-boolean for sync/verify/advance/mirrorState", () => {
    for (const k of ["sync", "verify", "advance", "mirrorState"]) {
      const p = writeProfile(
        baseProfile({
          lifecycle: "pr-branch",
          lifecycleConfig: {
            label: { name: "kody:test", color: "abc123", description: "x" },
            [k]: "yes",
          },
          scripts: { preflight: [], postflight: [] },
        }),
      )
      expect(() => loadProfile(p)).toThrow(new RegExp(`${k} must be a boolean`))
    }
  })
})

describe("live profiles using pr-branch lifecycle", () => {
  const repoRoot = path.resolve(__dirname, "../../..")

  it("run expands with sync:false, contextExtras=resolveArtifacts, mirrorState:true", () => {
    const profile = loadProfile(path.join(repoRoot, "src/implementations/run/profile.json"))
    expect(profile.lifecycle).toBe("pr-branch")
    const pre = profile.scripts.preflight.map((e) => e.script)
    expect(pre).not.toContain("syncFlow")
    expect(pre[0]).toBe("setLifecycleLabel")
    expect(pre.indexOf("runFlow")).toBe(1)
    // resolveArtifacts must come right after loadTaskState
    expect(pre.indexOf("resolveArtifacts")).toBe(pre.indexOf("loadTaskState") + 1)
    const post = profile.scripts.postflight.map((e) => e.script)
    expect(post.indexOf("requirePlanDeviations")).toBe(1)
    const save = post.indexOf("saveTaskState")
    const mirror = post.indexOf("mirrorStateToPr")
    const advance = post.indexOf("advanceFlow")
    expect(mirror).toBeGreaterThan(save)
    expect(advance).toBeGreaterThan(mirror)
    expect(post.at(-1)).toBe("finalizeTerminal")
    expect(post.indexOf("advanceFlow")).toBe(post.length - 2)
  })
})
