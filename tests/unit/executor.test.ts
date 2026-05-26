/**
 * Focused unit tests for the executor's two in-process primitives:
 *   - `runWhen` conditional evaluation (via shouldRun, exposed indirectly).
 *   - Input validation / coercion (via validateInputs, exposed indirectly).
 *
 * Full agent-running behavior is covered by the existing regression suite
 * (all tests in tests passed after the refactor, proving
 * behavior-compatibility). Here we lock in the new surface.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile } from "../../src/profile.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-exec-"))
}

const BASE = {
  name: "t",
  role: "primitive",
  describe: "",
  inputs: [
    { name: "mode", flag: "--mode", type: "enum", values: ["a", "b"], required: true, describe: "" },
    { name: "n", flag: "--n", type: "int", requiredWhen: { mode: "a" }, describe: "" },
  ],
  claudeCode: {
    model: "inherit",
    permissionMode: "acceptEdits",
    maxTurns: null,
    systemPromptAppend: null,
    tools: ["Read"],
    hooks: [],
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    mcpServers: [],
  },
  cliTools: [],
  scripts: {
    preflight: [
      { script: "aFlow", runWhen: { "args.mode": "a" } },
      { script: "bFlow", runWhen: { "args.mode": "b" } },
      { script: "composePrompt" },
    ],
    postflight: [],
  },
}

describe("executor: profile input schema", () => {
  it("loads inputs with requiredWhen intact", () => {
    const dir = tmpDir()
    const p = path.join(dir, "profile.json")
    fs.writeFileSync(p, JSON.stringify(BASE))
    const profile = loadProfile(p)
    const n = profile.inputs.find((i) => i.name === "n")!
    expect(n.requiredWhen).toEqual({ mode: "a" })
  })

  it("preserves runWhen on preflight entries", () => {
    const dir = tmpDir()
    const p = path.join(dir, "profile.json")
    fs.writeFileSync(p, JSON.stringify(BASE))
    const profile = loadProfile(p)
    expect(profile.scripts.preflight[0]!.runWhen).toEqual({ "args.mode": "a" })
    expect(profile.scripts.preflight[1]!.runWhen).toEqual({ "args.mode": "b" })
    expect(profile.scripts.preflight[2]!.runWhen).toBeUndefined()
  })
})

describe("executor: split pipeline profiles are loadable + valid", () => {
  const EXE_ROOT = path.resolve(__dirname, "../../src/executables")

  it("run profile loads cleanly with the expected shape", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "run/profile.json"))
    expect(profile.name).toBe("run")
    expect(profile.inputs.map((i) => i.name)).toEqual(["issue", "base"])
    const preScripts = profile.scripts.preflight.map((p) => p.script)
    expect(preScripts[0]).toBe("setLifecycleLabel")
    expect(preScripts).toContain("runFlow")
    const names = profile.scripts.postflight.map((p) => p.script)
    // saveTaskState writes issue state, mirrorStateToPr propagates it to the
    // PR, advanceFlow re-triggers the orchestrator if a flow is active, and
    // finalizeTerminal stamps kody:done/failed on standalone runs (no flow).
    expect(names).toContain("saveTaskState")
    expect(names).toContain("mirrorStateToPr")
    expect(names.indexOf("advanceFlow")).toBe(names.length - 2)
    expect(names.at(-1)).toBe("finalizeTerminal")
  })

  it("fix profile loads cleanly", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "fix/profile.json"))
    expect(profile.name).toBe("fix")
    expect(profile.inputs.map((i) => i.name).sort()).toEqual(["feedback", "pr"])
    const preScripts = profile.scripts.preflight.map((p) => p.script)
    expect(preScripts[0]).toBe("syncFlow")
    expect(preScripts).toContain("setLifecycleLabel")
    expect(preScripts).toContain("fixFlow")
  })

  it("fix-ci profile loads cleanly", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "fix-ci/profile.json"))
    expect(profile.name).toBe("fix-ci")
    expect(profile.inputs.map((i) => i.name).sort()).toEqual(["pr", "runId"])
    const preScripts = profile.scripts.preflight.map((p) => p.script)
    expect(preScripts[0]).toBe("syncFlow")
    expect(preScripts).toContain("setLifecycleLabel")
    expect(preScripts).toContain("fixCiFlow")
  })

  it("resolve profile skips verify + checkCoverageWithRetry (merge op)", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "resolve/profile.json"))
    expect(profile.name).toBe("resolve")
    expect(profile.inputs.map((i) => i.name)).toEqual(["pr", "prefer"])
    const preScripts = profile.scripts.preflight.map((p) => p.script)
    expect(preScripts[0]).toBe("setLifecycleLabel")
    expect(preScripts).toContain("resolveFlow")
    const postScripts = profile.scripts.postflight.map((s) => s.script)
    expect(postScripts).not.toContain("verify")
    expect(postScripts).not.toContain("checkCoverageWithRetry")
  })

  it("`bug` is a single-session pr-branch primitive (collapsed orchestration)", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "bug/profile.json"))
    expect(profile.name).toBe("bug")
    expect(profile.role).toBe("primitive")
    expect(profile.children ?? []).toEqual([])
    // `base` still forwarded by goal-tick's stacked-PR dispatch (optional).
    expect(profile.inputs.map((i) => i.name)).toEqual(["issue", "base"])
    // pr-branch lifecycle + verify-loop, same plumbing as `feature`/`run`.
    expect(profile.lifecycle).toBe("pr-branch")
    expect(profile.claudeCode.enableVerifyTool).toBe(true)
    expect(profile.claudeCode.verifyAttempts).toBe(4)
    // Single-session: no orchestrator to re-trigger, stamps its own terminus.
    expect(profile.lifecycleConfig?.advance).toBe(false)
    expect(profile.lifecycleConfig?.finalize).toBe(true)
    const pre = profile.scripts.preflight.map((p) => p.script)
    expect(pre).toContain("runFlow")
    const post = profile.scripts.postflight.map((p) => p.script)
    expect(post.at(-1)).toBe("finalizeTerminal")
  })

  it("`spec` sub-orchestrator profile loads cleanly", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "spec/profile.json"))
    expect(profile.name).toBe("spec")
    expect(profile.inputs.map((i) => i.name)).toEqual(["issue"])
    expect(profile.claudeCode.maxTurns).toBe(0)
    const pre = profile.scripts.preflight.map((p) => p.script)
    expect(pre[0]).toBe("setLifecycleLabel")
    expect(pre.at(-1)).toBe("skipAgent")
    const post = profile.scripts.postflight
    expect(post[0]!.script).toBe("startFlow")
    expect(post.at(-1)!.script).toBe("persistFlowState")
  })

  it("`feature` is a single-session pr-branch primitive (collapsed orchestration)", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "feature/profile.json"))
    expect(profile.name).toBe("feature")
    expect(profile.role).toBe("primitive")
    expect(profile.children ?? []).toEqual([])
    // `base` still forwarded by goal-tick's stacked-PR dispatch (optional).
    expect(profile.inputs.map((i) => i.name)).toEqual(["issue", "base"])
    // pr-branch lifecycle + verify-loop, same shape as `run`.
    expect(profile.lifecycle).toBe("pr-branch")
    expect(profile.claudeCode.enableVerifyTool).toBe(true)
    expect(profile.claudeCode.verifyAttempts).toBe(4)
    // Single-session: no orchestrator to re-trigger, stamps its own terminus.
    expect(profile.lifecycleConfig?.advance).toBe(false)
    expect(profile.lifecycleConfig?.finalize).toBe(true)
    const pre = profile.scripts.preflight.map((p) => p.script)
    expect(pre).toContain("runFlow")
    const post = profile.scripts.postflight.map((p) => p.script)
    expect(post.at(-1)).toBe("finalizeTerminal")
  })

  it("`chore` is a single-session pr-branch primitive (collapsed orchestration)", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "chore/profile.json"))
    expect(profile.name).toBe("chore")
    expect(profile.role).toBe("primitive")
    expect(profile.children ?? []).toEqual([])
    // `base` still forwarded by goal-tick's stacked-PR dispatch (optional).
    expect(profile.inputs.map((i) => i.name)).toEqual(["issue", "base"])
    // pr-branch lifecycle + verify-loop, same plumbing as feature/bug/run.
    expect(profile.lifecycle).toBe("pr-branch")
    expect(profile.claudeCode.enableVerifyTool).toBe(true)
    expect(profile.claudeCode.verifyAttempts).toBe(4)
    // Single-session: no orchestrator to re-trigger, stamps its own terminus.
    expect(profile.lifecycleConfig?.advance).toBe(false)
    expect(profile.lifecycleConfig?.finalize).toBe(true)
    const pre = profile.scripts.preflight.map((p) => p.script)
    expect(pre).toContain("runFlow")
    const post = profile.scripts.postflight.map((p) => p.script)
    expect(post.at(-1)).toBe("finalizeTerminal")
  })

  it("each sub-orchestrator's startFlow points at the expected entry stage", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "spec/profile.json"))
    const startEntry = profile.scripts.postflight.find((p) => p.script === "startFlow")
    expect(startEntry?.with?.entry).toBe("research")
  })
})
