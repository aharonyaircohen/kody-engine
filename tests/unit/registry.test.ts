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
  parseGenericFlags,
  resolveAgentAction,
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
