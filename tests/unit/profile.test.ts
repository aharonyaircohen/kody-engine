import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, ProfileError, validateScriptReferences } from "../../src/profile.js"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-profile-"))
}

function writeProfile(dir: string, profile: unknown): string {
  const p = path.join(dir, "profile.json")
  fs.writeFileSync(p, JSON.stringify(profile, null, 2))
  return p
}

const VALID_MIN = {
  name: "mini",
  role: "primitive",
  describe: "smallest valid profile",
  inputs: [{ name: "foo", flag: "--foo", type: "string", describe: "" }],
  claudeCode: {
    model: "inherit",
    permissionMode: "acceptEdits",
    maxTurns: null,
    maxThinkingTokens: null,
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
  scripts: { preflight: [{ script: "composePrompt" }], postflight: [] },
}

describe("profile: loadProfile", () => {
  it("loads a minimal valid profile", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, VALID_MIN)
    const profile = loadProfile(p)
    expect(profile.name).toBe("mini")
    expect(profile.dir).toBe(dir)
    expect(profile.scripts.preflight[0]!.script).toBe("composePrompt")
  })

  it("parses claudeCode.reasoningEffort on agentAction profiles", () => {
    const dir = tmpDir()
    const profile = loadProfile(
      writeProfile(dir, { ...VALID_MIN, claudeCode: { ...VALID_MIN.claudeCode, reasoningEffort: "high" } }),
    )
    expect(profile.claudeCode.reasoningEffort).toBe("high")
  })

  it("parses optional capabilityKind on agentAction profiles", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, { ...VALID_MIN, capabilityKind: "observe" }))

    expect(profile.capabilityKind).toBe("observe")
  })

  it("rejects invalid capabilityKind values", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { ...VALID_MIN, capabilityKind: "manager" })

    expect(() => loadProfile(p)).toThrow(/capabilityKind/)
  })

  it("parses agent and ignores legacy every on agentResponsibility fields", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, { ...VALID_MIN, agent: "kody", every: "1h" }))
    expect(profile.agent).toBe("kody")
    expect((profile as unknown as Record<string, unknown>).every).toBeUndefined()
    const dir2 = tmpDir()
    const blanks = loadProfile(writeProfile(dir2, { ...VALID_MIN, agent: "  ", every: "" }))
    expect(blanks.agent).toBeUndefined()
    expect((blanks as unknown as Record<string, unknown>).every).toBeUndefined()
  })

  it("rejects agentResponsibilityTools not in the kody-agentResponsibility palette (fail-fast at load)", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { ...VALID_MIN, agentResponsibilityTools: ["read_check_runs", "not_a_real_tool"] })
    expect(() => loadProfile(p)).toThrow(/agentResponsibilityTools not in the kody-agentResponsibility palette/)
  })

  it("accepts agentResponsibilityTools that are all in the palette", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { ...VALID_MIN, agentResponsibilityTools: ["read_check_runs", "ensure_issue"] })
    expect(loadProfile(p).agentResponsibilityTools).toEqual(["read_check_runs", "ensure_issue"])
  })

  it("rejects writeJobStateFile postflight without a state loader preflight", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...VALID_MIN,
      scripts: { preflight: [{ script: "composePrompt" }], postflight: [{ script: "writeJobStateFile" }] },
    })
    expect(() => loadProfile(p)).toThrow(/no state loader/)
  })

  it("accepts the state postflights when loadAgentResponsibilityState is in preflight", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "loadAgentResponsibilityState" }, { script: "composePrompt" }],
        postflight: [{ script: "parseJobStateFromAgentResult" }, { script: "writeJobStateFile" }],
      },
    })
    expect(() => loadProfile(p)).not.toThrow()
  })

  it("accepts state postflights when runScheduledAgentActionTick is in preflight", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "runScheduledAgentActionTick" }],
        postflight: [{ script: "writeJobStateFile" }],
      },
    })
    expect(() => loadProfile(p)).not.toThrow()
  })

  it("resolves a agentResponsibility that references an agentAction (how) + overlays who/when/tools", () => {
    // A thin agentResponsibility: references the engine's `merge` agentAction (the HOW), adds
    // its own name + agent (WHO). No claudeCode of its own.
    const dir = tmpDir()
    const p = writeProfile(dir, {
      name: "merge-daily",
      agentAction: "merge",
      agent: "cto",
      every: "1d",
      agentResponsibilityTools: ["ensure_issue"],
    })
    const profile = loadProfile(p)
    expect(profile.name).toBe("merge-daily") // agentResponsibility identity
    expect(profile.agentAction).toBe("merge") // how (preserved for prompt/job reference)
    expect(profile.agent).toBe("cto") // who (overlaid)
    expect((profile as unknown as Record<string, unknown>).every).toBeUndefined() // legacy cadence ignored
    expect(profile.agentResponsibilityTools).toEqual(["ensure_issue"]) // toolbox (overlaid)
    // how came from the referenced agentAction: dir + claudeCode are merge's.
    expect(profile.dir.endsWith(path.join("agent-actions", "merge"))).toBe(true)
    expect(profile.claudeCode).toBeTruthy()
  })

  it("overlays capabilityKind on thin agentResponsibility references", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      name: "merge-ready-check",
      agentAction: "merge",
      capabilityKind: "verify",
    })

    const profile = loadProfile(p)

    expect(profile.name).toBe("merge-ready-check")
    expect(profile.agentAction).toBe("merge")
    expect(profile.capabilityKind).toBe("verify")
  })

  it("throws when a agentResponsibility references an unknown agentAction", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { name: "x", agentAction: "no-such-agentAction-xyz" })
    expect(() => loadProfile(p)).toThrow(/references unknown agentAction/)
  })

  it("throws on missing file", () => {
    expect(() => loadProfile(`/tmp/nope-${Math.random()}/profile.json`)).toThrow(ProfileError)
  })

  it("throws on invalid JSON", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "profile.json"), "{not json")
    expect(() => loadProfile(path.join(dir, "profile.json"))).toThrow(/invalid JSON/)
  })

  it("rejects missing name", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN } as Record<string, unknown>
    delete bad.name
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/"name" must be a non-empty string/)
  })

  it("rejects missing role", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN } as Record<string, unknown>
    delete bad.role
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/"role" is required/)
  })

  it("rejects invalid role value", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN, role: "bogus" }
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/"role" is required/)
  })

  it("rejects enum input without values", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN, inputs: [{ name: "x", flag: "--x", type: "enum", describe: "" }] }
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/requires non-empty "values"/)
  })

  it("rejects invalid permissionMode", () => {
    const dir = tmpDir()
    const bad = { ...VALID_MIN, claudeCode: { ...VALID_MIN.claudeCode, permissionMode: "rogue" } }
    const p = writeProfile(dir, bad)
    expect(() => loadProfile(p)).toThrow(/permissionMode must be one of/)
  })

  it("accepts empty tools (configless agentActions like init/release)", () => {
    const dir = tmpDir()
    const good = { ...VALID_MIN, claudeCode: { ...VALID_MIN.claudeCode, tools: [] } }
    const p = writeProfile(dir, good)
    const profile = loadProfile(p)
    expect(profile.claudeCode.tools).toEqual([])
  })

  it("accepts shorthand string cliTools entries", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, { ...VALID_MIN, cliTools: ["gh"] }))

    expect(profile.cliTools).toEqual([
      {
        name: "gh",
        install: { required: false, checkCommand: "command -v gh" },
        verify: "command -v gh",
        usage: "",
        allowedUses: [],
      },
    ])
  })

  it("preserves runWhen on script entries", () => {
    const dir = tmpDir()
    const good = {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "runFlow", runWhen: { "args.mode": "run" } }],
        postflight: [],
      },
    }
    const p = writeProfile(dir, good)
    const profile = loadProfile(p)
    expect(profile.scripts.preflight[0]!.runWhen).toEqual({ "args.mode": "run" })
  })
})

describe("profile: validateScriptReferences", () => {
  it("returns names not in the registry", () => {
    const dir = tmpDir()
    const profile = loadProfile(
      writeProfile(dir, {
        ...VALID_MIN,
        scripts: {
          preflight: [{ script: "unknownScript" }, { script: "composePrompt" }],
          postflight: [{ script: "verify" }],
        },
      }),
    )
    const missing = validateScriptReferences(profile, new Set(["composePrompt", "verify"]))
    expect(missing).toEqual(["unknownScript"])
  })

  it("returns empty when all scripts registered", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, VALID_MIN))
    const missing = validateScriptReferences(profile, new Set(["composePrompt"]))
    expect(missing).toEqual([])
  })
})
