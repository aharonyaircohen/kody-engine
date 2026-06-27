import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import { loadProfile, ProfileError, validateScriptReferences } from "../../src/profile.js"
import { resolveExecutable } from "../../src/registry.js"
import { setupCompanyStoreFixture } from "./_helpers/companyStoreFixture.js"

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

  it("parses claudeCode.reasoningEffort on executable profiles", () => {
    const dir = tmpDir()
    const profile = loadProfile(
      writeProfile(dir, { ...VALID_MIN, claudeCode: { ...VALID_MIN.claudeCode, reasoningEffort: "high" } }),
    )
    expect(profile.claudeCode.reasoningEffort).toBe("high")
  })

  it("parses agent and ignores legacy every on capability fields", () => {
    const dir = tmpDir()
    const profile = loadProfile(writeProfile(dir, { ...VALID_MIN, agent: "kody", every: "1h" }))
    expect(profile.agent).toBe("kody")
    expect((profile as unknown as Record<string, unknown>).every).toBeUndefined()
    const dir2 = tmpDir()
    const blanks = loadProfile(writeProfile(dir2, { ...VALID_MIN, agent: "  ", every: "" }))
    expect(blanks.agent).toBeUndefined()
    expect((blanks as unknown as Record<string, unknown>).every).toBeUndefined()
  })

  it("rejects capabilityTools not in the kody-capability palette (fail-fast at load)", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { ...VALID_MIN, capabilityTools: ["read_check_runs", "not_a_real_tool"] })
    expect(() => loadProfile(p)).toThrow(/capabilityTools not in the kody-capability palette/)
  })

  it("accepts capabilityTools that are all in the palette", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { ...VALID_MIN, capabilityTools: ["read_check_runs", "ensure_issue"] })
    expect(loadProfile(p).capabilityTools).toEqual(["read_check_runs", "ensure_issue"])
  })

  it("rejects writeJobStateFile postflight without a state loader preflight", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...VALID_MIN,
      scripts: { preflight: [{ script: "composePrompt" }], postflight: [{ script: "writeJobStateFile" }] },
    })
    expect(() => loadProfile(p)).toThrow(/no state loader/)
  })

  it("accepts the state postflights when loadCapabilityState is in preflight", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "loadCapabilityState" }, { script: "composePrompt" }],
        postflight: [{ script: "parseJobStateFromAgentResult" }, { script: "writeJobStateFile" }],
      },
    })
    expect(() => loadProfile(p)).not.toThrow()
  })

  it("accepts state postflights when runScheduledExecutableTick is in preflight", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, {
      ...VALID_MIN,
      scripts: {
        preflight: [{ script: "runScheduledExecutableTick" }],
        postflight: [{ script: "writeJobStateFile" }],
      },
    })
    expect(() => loadProfile(p)).not.toThrow()
  })

  it("resolves a capability that references an executable (how) + overlays who/when/tools", () => {
    // The referenced `merge` executable is provided by the company-store fixture
    // so the test is self-sufficient — it doesn't rely on a sibling kody-store
    // repo being checked out next to this one.
    const fixture = setupCompanyStoreFixture({ capabilities: ["merge"] })
    try {
      resetCompanyStoreCacheForTests()
      // A thin capability: references the engine's `merge` executable (the HOW), adds
      // its own name + agent (WHO). No claudeCode of its own.
      const dir = tmpDir()
      const p = writeProfile(dir, {
        name: "merge-daily",
        executable: "merge",
        agent: "cto",
        every: "1d",
        capabilityTools: ["ensure_issue"],
      })
      const profile = loadProfile(p)
      expect(profile.name).toBe("merge-daily") // capability identity
      expect(profile.executable).toBe("merge") // how (preserved for prompt/job reference)
      expect(profile.agent).toBe("cto") // who (overlaid)
      expect((profile as unknown as Record<string, unknown>).every).toBeUndefined() // legacy cadence ignored
      expect(profile.capabilityTools).toEqual(["ensure_issue"]) // toolbox (overlaid)
      // how came from the referenced implementation profile: canonical
      // capabilities resolve before legacy executables during migration.
      const resolvedMerge = resolveExecutable("merge")
      expect(resolvedMerge).toBeTruthy()
      expect(profile.dir).toBe(path.dirname(resolvedMerge!))
      expect(profile.claudeCode).toBeTruthy()
    } finally {
      fixture.cleanup()
      resetCompanyStoreCacheForTests()
    }
  })

  it("throws when a capability references an unknown executable", () => {
    const dir = tmpDir()
    const p = writeProfile(dir, { name: "x", executable: "no-such-executable-xyz" })
    expect(() => loadProfile(p)).toThrow(/references unknown executable/)
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

  it("accepts empty tools (configless executables like init/release)", () => {
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
