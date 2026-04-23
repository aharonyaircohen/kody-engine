import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { loadProfile, validateScriptReferences } from "../../src/profile.js"
import { allScriptNames } from "../../src/scripts/index.js"

const PROFILE_PATH = path.resolve(__dirname, "../../src/executables/ui-review/profile.json")

describe("ui-review profile", () => {
  const profile = loadProfile(PROFILE_PATH)

  it("has the expected identity", () => {
    expect(profile.name).toBe("ui-review")
    expect(profile.kind).toBe("oneshot")
  })

  it("declares --pr (required) and --preview-url (optional)", () => {
    const byName = Object.fromEntries(profile.inputs.map((i) => [i.name, i]))
    expect(byName.pr?.required).toBe(true)
    expect(byName.pr?.type).toBe("int")
    expect(byName.previewUrl?.required).toBeFalsy()
    expect(byName.previewUrl?.type).toBe("string")
  })

  it("declares the playwright cli tool with an install command", () => {
    const pw = profile.cliTools.find((t) => t.name === "playwright")
    expect(pw).toBeDefined()
    expect(pw!.install.checkCommand).toContain("playwright")
    expect(pw!.install.installCommand).toContain("playwright install")
    expect(pw!.usage.length).toBeGreaterThan(10)
  })

  it("allows the agent to use Bash + Write (needed for Playwright specs)", () => {
    const tools = new Set(profile.claudeCode.tools)
    expect(tools.has("Bash")).toBe(true)
    expect(tools.has("Write")).toBe(true)
    expect(tools.has("Read")).toBe(true)
  })

  it("has the full preflight chain in the right order", () => {
    const names = profile.scripts.preflight.map((e) => e.script)
    const idx = (s: string): number => names.indexOf(s)
    expect(idx("reviewFlow")).toBeGreaterThanOrEqual(0)
    expect(idx("discoverQaContext")).toBeGreaterThan(idx("reviewFlow"))
    expect(idx("loadQaGuide")).toBeGreaterThan(-1)
    expect(idx("resolvePreviewUrl")).toBeGreaterThan(-1)
    // composePrompt must be last so all tokens are populated
    expect(idx("composePrompt")).toBe(names.length - 1)
  })

  it("every referenced script is registered", () => {
    expect(validateScriptReferences(profile, allScriptNames)).toEqual([])
  })
})
