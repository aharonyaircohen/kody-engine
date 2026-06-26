import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import {
  builtinExecutableNames,
  hasExecutable,
  isBuiltinExecutable,
  isSafeName,
  listExecutables,
  listCapabilityActions,
  parseGenericFlags,
  resolveExecutable,
  resolveCapabilityAction,
  resolveCapabilityFolder,
} from "../../src/registry.js"

function mkFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-registry-"))
}

function writeProfile(root: string, name: string, body: object = {}): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(body))
}

describe("registry: builtin executables", () => {
  it("detects the engine-bundled executables by name", () => {
    const names = builtinExecutableNames()
    // a sample of known engine builtins
    expect(names.has("run")).toBe(true)
    expect(names.has("merge")).toBe(true)
    expect(names.has("capability-scheduler")).toBe(false)
  })

  it("isBuiltinExecutable is true for builtins, false for custom names", () => {
    expect(isBuiltinExecutable("run")).toBe(true)
    expect(isBuiltinExecutable("merge")).toBe(true)
    expect(isBuiltinExecutable("a-custom-consumer-capability-xyz")).toBe(false)
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

describe("registry: listExecutables", () => {
  let root: string

  beforeEach(() => {
    root = mkFixture()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("returns empty when root has no executables", () => {
    expect(listExecutables(root)).toEqual([])
  })

  it("returns empty when root does not exist", () => {
    expect(listExecutables(path.join(root, "nope"))).toEqual([])
  })

  it("finds every directory containing profile.json", () => {
    writeProfile(root, "build", { name: "build" })
    writeProfile(root, "review", { name: "review" })
    writeProfile(root, "watch-stale-prs", { name: "watch-stale-prs" })

    const names = listExecutables(root).map((e) => e.name)
    expect(names).toEqual(["build", "review", "watch-stale-prs"])
  })

  it("skips directories without a profile.json (e.g. shared modules)", () => {
    writeProfile(root, "build", {})
    fs.mkdirSync(path.join(root, "types"), { recursive: true })
    fs.writeFileSync(path.join(root, "types", "types.ts"), "export {}")

    const names = listExecutables(root).map((e) => e.name)
    expect(names).toEqual(["build"])
  })

  it("returns absolute profilePath for each discovery", () => {
    writeProfile(root, "init", {})
    const [exe] = listExecutables(root)
    expect(exe?.profilePath).toBe(path.join(root, "init", "profile.json"))
    expect(fs.existsSync(exe!.profilePath)).toBe(true)
  })
})

describe("registry: capability/executable separation", () => {
  let root: string
  let previousStore: string | undefined
  const prevCwd = process.cwd()

  beforeEach(() => {
    root = mkFixture()
    previousStore = process.env.KODY_COMPANY_STORE
    process.env.KODY_COMPANY_STORE = "0"
    resetCompanyStoreCacheForTests()
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (previousStore === undefined) delete process.env.KODY_COMPANY_STORE
    else process.env.KODY_COMPANY_STORE = previousStore
    resetCompanyStoreCacheForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("resolves project executables while keeping capability folders as public actions", () => {
    const dutyDir = path.join(root, ".kody", "capabilities", "feature")
    const exeDir = path.join(root, ".kody", "executables", "feature")
    fs.mkdirSync(dutyDir, { recursive: true })
    fs.mkdirSync(exeDir, { recursive: true })
    fs.writeFileSync(
      path.join(dutyDir, "profile.json"),
      JSON.stringify({ name: "feature", action: "feature", executable: "feature" }),
    )
    fs.writeFileSync(path.join(dutyDir, "capability.md"), "# Feature\n")
    fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify({ name: "feature", role: "primitive" }))

    expect(fs.realpathSync(resolveExecutable("feature")!)).toBe(
      fs.realpathSync(path.join(exeDir, "profile.json")),
    )
    expect(fs.realpathSync(listExecutables().find((exe) => exe.name === "feature")!.profilePath)).toBe(
      fs.realpathSync(path.join(exeDir, "profile.json")),
    )
    expect(resolveCapabilityAction("feature")).toMatchObject({
      action: "feature",
      capability: "feature",
      executable: "feature",
      source: "project-folder",
    })
  })
})

describe("registry: capabilities root", () => {
  let root: string
  let previousStore: string | undefined
  const prevCwd = process.cwd()

  beforeEach(() => {
    root = mkFixture()
    previousStore = process.env.KODY_COMPANY_STORE
    process.env.KODY_COMPANY_STORE = "0"
    resetCompanyStoreCacheForTests()
    process.chdir(root)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    if (previousStore === undefined) delete process.env.KODY_COMPANY_STORE
    else process.env.KODY_COMPANY_STORE = previousStore
    resetCompanyStoreCacheForTests()
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
        implementation: "triage",
        describe: "Triage incoming work.",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Triage\n\nWatch incoming work.\n")

    expect(resolveCapabilityAction("triage")).toMatchObject({
      action: "triage",
      capability: "triage",
      executable: "triage",
      source: "project-folder",
    })
    expect(fs.realpathSync(resolveCapabilityFolder("triage")!.bodyPath)).toBe(
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
        role: "primitive",
        describe: "Ship requested work.",
        inputs: [{ name: "issue", flag: "--issue", type: "int", required: true }],
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n\nShip requested work.\n")

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "ship",
      executable: "ship",
      source: "project-folder",
    })
  })

  it("prefers full .kody/capabilities implementation profiles over project executables", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    const executableDir = path.join(root, ".kody", "executables", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(executableDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "capability-ship", role: "primitive" }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n")
    fs.writeFileSync(path.join(executableDir, "profile.json"), JSON.stringify({ name: "executable-ship", role: "primitive" }))

    expect(fs.realpathSync(resolveExecutable("ship")!)).toBe(
      fs.realpathSync(path.join(capabilityDir, "profile.json")),
    )
    expect(fs.realpathSync(listExecutables().find((item) => item.name === "ship")!.profilePath)).toBe(
      fs.realpathSync(path.join(capabilityDir, "profile.json")),
    )
  })

  it("does not treat thin .kody/capabilities contracts as implementation profiles", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    const executableDir = path.join(root, ".kody", "executables", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(executableDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({
        name: "ship",
        action: "ship",
        implementation: "ship",
        describe: "Public shipping contract.",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n")
    fs.writeFileSync(path.join(executableDir, "profile.json"), JSON.stringify({ name: "executable-ship", role: "primitive" }))

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "ship",
      executable: "ship",
      source: "project-folder",
    })
    expect(fs.realpathSync(resolveExecutable("ship")!)).toBe(
      fs.realpathSync(path.join(executableDir, "profile.json")),
    )
    expect(fs.realpathSync(listExecutables().find((item) => item.name === "ship")!.profilePath)).toBe(
      fs.realpathSync(path.join(executableDir, "profile.json")),
    )
  })

  it("does not read removed capabilities roots as capability fallbacks", () => {
    const oldRoot = ["agent", "respon", "sibilities"].join("-")
    const oldBody = ["agent", "respon", "sibility.md"].join("-")
    const legacyDir = path.join(root, ".kody", oldRoot, "audit")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(
      path.join(legacyDir, "profile.json"),
      JSON.stringify({ name: "audit", action: "audit" }),
    )
    fs.writeFileSync(path.join(legacyDir, oldBody), "# Audit\n\nLegacy body.\n")

    expect(listCapabilityActions().find((item) => item.action === "audit")).toBeUndefined()
    expect(resolveCapabilityFolder("audit")).toBeNull()
  })
})

describe("registry: hasExecutable", () => {
  let root: string
  beforeEach(() => {
    root = mkFixture()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("true when the profile exists", () => {
    writeProfile(root, "review", {})
    expect(hasExecutable("review", root)).toBe(true)
  })

  it("false when the directory exists but profile.json is missing", () => {
    fs.mkdirSync(path.join(root, "review"), { recursive: true })
    expect(hasExecutable("review", root)).toBe(false)
  })

  it("false on unknown name", () => {
    expect(hasExecutable("nothing", root)).toBe(false)
  })

  it("rejects unsafe names without touching the filesystem", () => {
    writeProfile(root, "build", {})
    expect(hasExecutable("../build", root)).toBe(false)
    expect(hasExecutable("..", root)).toBe(false)
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
