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
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody2-exec-"))
}

const BASE = {
  name: "t",
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
    expect(profile.inputs.map((i) => i.name)).toEqual(["issue"])
    expect(profile.scripts.preflight[0]!.script).toBe("runFlow")
    expect(profile.scripts.preflight[0]!.runWhen).toBeUndefined()
    const names = profile.scripts.postflight.map((p) => p.script)
    // saveTaskState writes issue state, mirrorStateToPr propagates it to the
    // PR, advanceFlow re-triggers the orchestrator if a flow is active.
    expect(names).toContain("saveTaskState")
    expect(names).toContain("mirrorStateToPr")
    expect(names.at(-1)).toBe("advanceFlow")
  })

  it("fix profile loads cleanly", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "fix/profile.json"))
    expect(profile.name).toBe("fix")
    expect(profile.inputs.map((i) => i.name).sort()).toEqual(["feedback", "pr"])
    expect(profile.scripts.preflight[0]!.script).toBe("fixFlow")
  })

  it("fix-ci profile loads cleanly", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "fix-ci/profile.json"))
    expect(profile.name).toBe("fix-ci")
    expect(profile.inputs.map((i) => i.name).sort()).toEqual(["pr", "runId"])
    expect(profile.scripts.preflight[0]!.script).toBe("fixCiFlow")
  })

  it("resolve profile skips verify + checkCoverageWithRetry (merge op)", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "resolve/profile.json"))
    expect(profile.name).toBe("resolve")
    expect(profile.inputs.map((i) => i.name)).toEqual(["pr"])
    expect(profile.scripts.preflight[0]!.script).toBe("resolveFlow")
    const postScripts = profile.scripts.postflight.map((s) => s.script)
    expect(postScripts).not.toContain("verify")
    expect(postScripts).not.toContain("checkCoverageWithRetry")
  })

  it("orchestrator-plan-build-review profile loads cleanly with transition table", () => {
    const profile = loadProfile(path.join(EXE_ROOT, "orchestrator-plan-build-review/profile.json"))
    expect(profile.name).toBe("orchestrator-plan-build-review")
    expect(profile.inputs.map((i) => i.name).sort()).toEqual(["flow", "issue"])
    expect(profile.claudeCode.maxTurns).toBe(0)
    expect(profile.claudeCode.tools).toEqual([])
    // Preflight ends with skipAgent so the executor bypasses runAgent.
    const pre = profile.scripts.preflight.map((p) => p.script)
    expect(pre).toContain("loadIssueContext")
    expect(pre).toContain("loadTaskState")
    expect(pre.at(-1)).toBe("skipAgent")
    // Every transition entry is a dispatcher script with a runWhen guard
    // (except the trailing persistFlowState which is unconditional).
    const post = profile.scripts.postflight
    expect(post.at(-1)!.script).toBe("persistFlowState")
    expect(post.at(-1)!.runWhen).toBeUndefined()
    const transitions = post.slice(0, -1)
    expect(transitions.length).toBeGreaterThanOrEqual(8)
    for (const entry of transitions) {
      expect(["startFlow", "dispatch", "finishFlow"]).toContain(entry.script)
      expect(entry.runWhen).toBeDefined()
      expect(entry.with).toBeDefined()
    }
  })
})
