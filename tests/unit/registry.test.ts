import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  builtinAgentActionNames,
  hasAgentAction,
  isBuiltinAgentAction,
  isSafeName,
  listAgentActions,
  listAgentResponsibilityActions,
  parseGenericFlags,
  resolveAgentAction,
  resolveAgentResponsibilityAction,
  resolveAgentResponsibilityFolder,
} from "../../src/registry.js"

function mkFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-registry-"))
}

function writeProfile(root: string, name: string, body: object = {}): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(body))
}

describe("registry: builtin agentActions", () => {
  it("detects the engine-bundled agentActions by name", () => {
    const names = builtinAgentActionNames()
    // a sample of known engine builtins
    expect(names.has("run")).toBe(true)
    expect(names.has("merge")).toBe(false)
    expect(names.has("agent-responsibility-scheduler")).toBe(false)
  })

  it("isBuiltinAgentAction is true for builtins, false for custom names", () => {
    expect(isBuiltinAgentAction("run")).toBe(true)
    expect(isBuiltinAgentAction("merge")).toBe(false)
    expect(isBuiltinAgentAction("a-custom-consumer-agentResponsibility-xyz")).toBe(false)
  })
})

describe("registry: isSafeName", () => {
  it("allows lowercase-with-dashes", () => {
    expect(isSafeName("build")).toBe(true)
    expect(isSafeName("watch-stale-prs")).toBe(true)
    expect(isSafeName("review2")).toBe(true)
  })

  it("rejects traversal and unsafe characters", () => {
    expect(isSafeName("..")).toBe(false)
    expect(isSafeName("../etc/passwd")).toBe(false)
    expect(isSafeName("my..dir")).toBe(false)
    expect(isSafeName("Caps")).toBe(false)
    expect(isSafeName("with space")).toBe(false)
    expect(isSafeName("with/slash")).toBe(false)
    expect(isSafeName("")).toBe(false)
  })
})

describe("registry: listAgentActions", () => {
  let root: string

  beforeEach(() => {
    root = mkFixture()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("returns empty when root has no agentActions", () => {
    expect(listAgentActions(root)).toEqual([])
  })

  it("returns empty when root does not exist", () => {
    expect(listAgentActions(path.join(root, "nope"))).toEqual([])
  })

  it("finds every directory containing profile.json", () => {
    writeProfile(root, "build", { name: "build" })
    writeProfile(root, "review", { name: "review" })
    writeProfile(root, "watch-stale-prs", { name: "watch-stale-prs" })

    const names = listAgentActions(root).map((e) => e.name)
    expect(names).toEqual(["build", "review", "watch-stale-prs"])
  })

  it("skips directories without a profile.json (e.g. shared modules)", () => {
    writeProfile(root, "build", {})
    fs.mkdirSync(path.join(root, "types"), { recursive: true })
    fs.writeFileSync(path.join(root, "types", "types.ts"), "export {}")

    const names = listAgentActions(root).map((e) => e.name)
    expect(names).toEqual(["build"])
  })

  it("returns absolute profilePath for each discovery", () => {
    writeProfile(root, "init", {})
    const [exe] = listAgentActions(root)
    expect(exe?.profilePath).toBe(path.join(root, "init", "profile.json"))
    expect(fs.existsSync(exe!.profilePath)).toBe(true)
  })
})

describe("registry: agentResponsibility/agentAction separation", () => {
  let root: string
  const prevCwd = process.cwd()

  beforeEach(() => {
    root = mkFixture()
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("resolves a agentResponsibility's same-name agentAction from .kody/agent-actions, not .kody/agent-responsibilities", () => {
    const dutyDir = path.join(root, ".kody", "agent-responsibilities", "feature")
    const exeDir = path.join(root, ".kody", "agent-actions", "feature")
    fs.mkdirSync(dutyDir, { recursive: true })
    fs.mkdirSync(exeDir, { recursive: true })
    fs.writeFileSync(
      path.join(dutyDir, "profile.json"),
      JSON.stringify({ name: "feature", action: "feature", agentAction: "feature" }),
    )
    fs.writeFileSync(path.join(dutyDir, "agent-responsibility.md"), "# Feature\n")
    fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify({ name: "feature" }))

    const expected = fs.realpathSync(path.join(exeDir, "profile.json"))
    expect(fs.realpathSync(resolveAgentAction("feature")!)).toBe(expected)
    expect(fs.realpathSync(listAgentActions().find((exe) => exe.name === "feature")!.profilePath)).toBe(expected)
  })
})

describe("registry: capabilities root", () => {
  let root: string
  const prevCwd = process.cwd()

  beforeEach(() => {
    root = mkFixture()
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("discovers .kody/capabilities folders as public capability actions", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "triage")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({
        name: "triage",
        action: "triage",
        capabilityKind: "observe",
        agentAction: "triage",
        describe: "Triage incoming work.",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Triage\n\nWatch incoming work.\n")

    expect(resolveAgentResponsibilityAction("triage")).toMatchObject({
      action: "triage",
      agentResponsibility: "triage",
      agentAction: "triage",
      source: "project-folder",
      capabilityKind: "observe",
    })
    expect(fs.realpathSync(resolveAgentResponsibilityFolder("triage")!.bodyPath)).toBe(
      fs.realpathSync(path.join(capabilityDir, "capability.md")),
    )
  })

  it("uses a full .kody/capabilities profile as its own implementation", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({
        name: "ship",
        action: "ship",
        capabilityKind: "act",
        role: "primitive",
        describe: "Ship requested work.",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: true }],
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n\nShip requested work.\n")

    expect(resolveAgentResponsibilityAction("ship")).toMatchObject({
      action: "ship",
      agentResponsibility: "ship",
      agentAction: "ship",
      source: "project-folder",
      capabilityKind: "act",
    })
  })

  it("resolves .kody/capabilities profiles as implementation profiles before legacy agent-actions", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    const legacyDir = path.join(root, ".kody", "agent-actions", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "capability-ship", role: "primitive" }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n")
    fs.writeFileSync(path.join(legacyDir, "profile.json"), JSON.stringify({ name: "legacy-ship" }))

    expect(fs.realpathSync(resolveAgentAction("ship")!)).toBe(fs.realpathSync(path.join(capabilityDir, "profile.json")))
    expect(fs.realpathSync(listAgentActions().find((item) => item.name === "ship")!.profilePath)).toBe(
      fs.realpathSync(path.join(capabilityDir, "profile.json")),
    )
  })

  it("does not treat thin .kody/capabilities contracts as implementation profiles", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    const legacyDir = path.join(root, ".kody", "agent-actions", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({
        name: "ship",
        action: "ship",
        capabilityKind: "act",
        agentAction: "ship",
        describe: "Public shipping contract.",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n")
    fs.writeFileSync(path.join(legacyDir, "profile.json"), JSON.stringify({ name: "legacy-ship" }))

    expect(resolveAgentResponsibilityAction("ship")).toMatchObject({
      action: "ship",
      agentResponsibility: "ship",
      agentAction: "ship",
      source: "project-folder",
      capabilityKind: "act",
    })
    expect(fs.realpathSync(resolveAgentAction("ship")!)).toBe(fs.realpathSync(path.join(legacyDir, "profile.json")))
    expect(fs.realpathSync(listAgentActions().find((item) => item.name === "ship")!.profilePath)).toBe(
      fs.realpathSync(path.join(legacyDir, "profile.json")),
    )
  })

  it("keeps legacy agent-responsibilities readable as fallback after capabilities", () => {
    const legacyDir = path.join(root, ".kody", "agent-responsibilities", "audit")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, "profile.json"),
      JSON.stringify({ name: "audit", action: "audit", capabilityKind: "verify" }),
    )
    fs.writeFileSync(path.join(legacyDir, "agent-responsibility.md"), "# Audit\n\nLegacy body.\n")

    expect(listAgentResponsibilityActions().find((item) => item.action === "audit")).toMatchObject({
      action: "audit",
      agentResponsibility: "audit",
      source: "project-folder",
      capabilityKind: "verify",
    })
    expect(fs.realpathSync(resolveAgentResponsibilityFolder("audit")!.bodyPath)).toBe(
      fs.realpathSync(path.join(legacyDir, "agent-responsibility.md")),
    )
  })
})

describe("registry: hasAgentAction", () => {
  let root: string
  beforeEach(() => {
    root = mkFixture()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("true when the profile exists", () => {
    writeProfile(root, "review", {})
    expect(hasAgentAction("review", root)).toBe(true)
  })

  it("false when the directory exists but profile.json is missing", () => {
    fs.mkdirSync(path.join(root, "review"), { recursive: true })
    expect(hasAgentAction("review", root)).toBe(false)
  })

  it("false on unknown name", () => {
    expect(hasAgentAction("nothing", root)).toBe(false)
  })

  it("rejects unsafe names without touching the filesystem", () => {
    writeProfile(root, "build", {})
    expect(hasAgentAction("../build", root)).toBe(false)
    expect(hasAgentAction("..", root)).toBe(false)
  })
})

describe("registry: parseGenericFlags", () => {
  it("parses --key value pairs", () => {
    expect(parseGenericFlags(["--pr", "42", "--cwd", "/tmp"])).toEqual({ pr: "42", cwd: "/tmp" })
  })

  it("parses --flag as boolean when no value follows", () => {
    expect(parseGenericFlags(["--verbose"])).toEqual({ verbose: true })
    expect(parseGenericFlags(["--pr", "5", "--verbose"])).toEqual({ pr: "5", verbose: true })
  })

  it("preserves positional args under _", () => {
    expect(parseGenericFlags(["foo", "--pr", "5", "bar"])).toEqual({ _: ["foo", "bar"], pr: "5" })
  })

  it("returns empty object for no argv", () => {
    expect(parseGenericFlags([])).toEqual({})
  })

  it("handles --flag followed by another --flag correctly", () => {
    expect(parseGenericFlags(["--dry-run", "--verbose"])).toEqual({
      "dry-run": true,
      dryRun: true,
      verbose: true,
    })
  })

  it("emits camelCase alias for dashed keys", () => {
    expect(parseGenericFlags(["--run-id", "123"])).toEqual({ "run-id": "123", runId: "123" })
  })
})
