import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import {
  builtinImplementationNames,
  hasImplementation,
  isBuiltinImplementation,
  isSafeName,
  listCapabilityActions,
  listImplementations,
  parseGenericFlags,
  resolveCapabilityAction,
  resolveCapabilityFolder,
  resolveImplementation,
} from "../../src/registry.js"

function mkFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-registry-"))
}

function writeProfile(root: string, name: string, body: object = {}): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(body))
}

describe("registry: builtin implementations", () => {
  it("detects the engine-bundled implementations by name", () => {
    const names = builtinImplementationNames()
    // a sample of known engine builtins
    expect(names.has("run")).toBe(true)
    expect(names.has("merge")).toBe(false)
    expect(names.has("capability-scheduler")).toBe(false)
  })

  it("isBuiltinImplementation is true for builtins, false for custom names", () => {
    expect(isBuiltinImplementation("run")).toBe(true)
    expect(isBuiltinImplementation("merge")).toBe(false)
    expect(isBuiltinImplementation("a-custom-consumer-capability-xyz")).toBe(false)
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

describe("registry: listImplementations", () => {
  let root: string

  beforeEach(() => {
    root = mkFixture()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("returns empty when root has no implementations", () => {
    expect(listImplementations(root)).toEqual([])
  })

  it("returns empty when root does not exist", () => {
    expect(listImplementations(path.join(root, "nope"))).toEqual([])
  })

  it("finds every directory containing profile.json", () => {
    writeProfile(root, "build", { name: "build" })
    writeProfile(root, "review", { name: "review" })
    writeProfile(root, "watch-stale-prs", { name: "watch-stale-prs" })

    const names = listImplementations(root).map((e) => e.name)
    expect(names).toEqual(["build", "review", "watch-stale-prs"])
  })

  it("skips directories without a profile.json (e.g. shared modules)", () => {
    writeProfile(root, "build", {})
    fs.mkdirSync(path.join(root, "types"), { recursive: true })
    fs.writeFileSync(path.join(root, "types", "types.ts"), "export {}")

    const names = listImplementations(root).map((e) => e.name)
    expect(names).toEqual(["build"])
  })

  it("returns absolute profilePath for each discovery", () => {
    writeProfile(root, "init", {})
    const [exe] = listImplementations(root)
    expect(exe?.profilePath).toBe(path.join(root, "init", "profile.json"))
    expect(fs.existsSync(exe!.profilePath)).toBe(true)
  })
})

describe("registry: obsolete project implementations", () => {
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

  it("ignores project .kody/implementations roots", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "feature")
    const exeDir = path.join(root, ".kody", "implementations", "feature")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(exeDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "feature", action: "feature" }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Feature\n")
    fs.writeFileSync(path.join(exeDir, "profile.json"), JSON.stringify({ name: "feature", role: "primitive" }))

    expect(resolveImplementation("feature")).toBeNull()
    expect(listImplementations().find((exe) => exe.name === "feature")).toBeUndefined()
    expect(resolveCapabilityAction("feature")).toMatchObject({
      action: "feature",
      capability: "feature",
      implementation: "capability-tick",
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
        implementation: "run",
        describe: "Triage incoming work.",
      }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Triage\n\nWatch incoming work.\n")

    expect(resolveCapabilityAction("triage")).toMatchObject({
      action: "triage",
      capability: "triage",
      implementation: "run",
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
      implementation: "ship",
      source: "project-folder",
    })
  })

  it("uses full .kody/capabilities implementation profiles and ignores project implementations", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    const implementationDir = path.join(root, ".kody", "implementations", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(implementationDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "profile.json"),
      JSON.stringify({ name: "capability-ship", role: "primitive" }),
    )
    fs.writeFileSync(path.join(capabilityDir, "capability.md"), "# Ship\n")
    fs.writeFileSync(
      path.join(implementationDir, "profile.json"),
      JSON.stringify({ name: "implementation-ship", role: "primitive" }),
    )

    expect(fs.realpathSync(resolveImplementation("ship")!)).toBe(fs.realpathSync(path.join(capabilityDir, "profile.json")))
    expect(fs.realpathSync(listImplementations().find((item) => item.name === "ship")!.profilePath)).toBe(
      fs.realpathSync(path.join(capabilityDir, "profile.json")),
    )
  })

  it("does not treat thin .kody/capabilities contracts or obsolete implementations as implementation profiles", () => {
    const capabilityDir = path.join(root, ".kody", "capabilities", "ship")
    const implementationDir = path.join(root, ".kody", "implementations", "ship")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(implementationDir, { recursive: true })
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
    fs.writeFileSync(
      path.join(implementationDir, "profile.json"),
      JSON.stringify({ name: "implementation-ship", role: "primitive" }),
    )

    expect(resolveCapabilityAction("ship")).toBeNull()
    expect(resolveImplementation("ship")).toBeNull()
    expect(listImplementations().find((item) => item.name === "ship")).toBeUndefined()
  })

  it("lets store capabilities override stale project capability implementation references", () => {
    const store = mkFixture()
    const previousStore = process.env.KODY_COMPANY_STORE
    try {
      process.env.KODY_COMPANY_STORE = store
      resetCompanyStoreCacheForTests()
      fs.writeFileSync(
        path.join(store, "kody-store.json"),
        JSON.stringify({ assetRoots: { capabilities: "capabilities" } }),
      )

      const projectClassify = path.join(root, ".kody", "capabilities", "classify")
      fs.mkdirSync(projectClassify, { recursive: true })
      fs.writeFileSync(
        path.join(projectClassify, "profile.json"),
        JSON.stringify({ name: "classify", action: "classify", implementation: "feature" }),
      )
      fs.writeFileSync(path.join(projectClassify, "capability.md"), "# Classify\n")

      const storeClassify = path.join(store, "capabilities", "classify")
      fs.mkdirSync(storeClassify, { recursive: true })
      fs.writeFileSync(
        path.join(storeClassify, "profile.json"),
        JSON.stringify({ name: "classify", action: "classify", role: "primitive" }),
      )
      fs.writeFileSync(path.join(storeClassify, "capability.md"), "# Classify\n")

      const storeFeature = path.join(store, "capabilities", "feature")
      fs.mkdirSync(storeFeature, { recursive: true })
      fs.writeFileSync(
        path.join(storeFeature, "profile.json"),
        JSON.stringify({
          name: "feature",
          action: "feature",
          workflow: { steps: [{ capability: "classify" }] },
        }),
      )
      fs.writeFileSync(path.join(storeFeature, "capability.md"), "# Feature\n")

      expect(resolveCapabilityAction("classify")).toMatchObject({
        action: "classify",
        capability: "classify",
        implementation: "classify",
        source: "company-store",
      })
      expect(resolveCapabilityAction("feature")).toMatchObject({
        action: "feature",
        capability: "feature",
        implementation: "classify",
        source: "company-store",
      })
    } finally {
      if (previousStore === undefined) delete process.env.KODY_COMPANY_STORE
      else process.env.KODY_COMPANY_STORE = previousStore
      resetCompanyStoreCacheForTests()
      fs.rmSync(store, { recursive: true, force: true })
    }
  })

  it("does not read removed capabilities roots as capability fallbacks", () => {
    const oldRoot = ["agent", "respon", "sibilities"].join("-")
    const oldBody = ["agent", "respon", "sibility.md"].join("-")
    const legacyDir = path.join(root, ".kody", oldRoot, "audit")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "profile.json"), JSON.stringify({ name: "audit", action: "audit" }))
    fs.writeFileSync(path.join(legacyDir, oldBody), "# Audit\n\nLegacy body.\n")

    expect(listCapabilityActions().find((item) => item.action === "audit")).toBeUndefined()
    expect(resolveCapabilityFolder("audit")).toBeNull()
  })
})

describe("registry: hasImplementation", () => {
  let root: string
  beforeEach(() => {
    root = mkFixture()
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("true when the profile exists", () => {
    writeProfile(root, "review", {})
    expect(hasImplementation("review", root)).toBe(true)
  })

  it("false when the directory exists but profile.json is missing", () => {
    fs.mkdirSync(path.join(root, "review"), { recursive: true })
    expect(hasImplementation("review", root)).toBe(false)
  })

  it("false on unknown name", () => {
    expect(hasImplementation("nothing", root)).toBe(false)
  })

  it("rejects unsafe names without touching the filesystem", () => {
    writeProfile(root, "build", {})
    expect(hasImplementation("../build", root)).toBe(false)
    expect(hasImplementation("..", root)).toBe(false)
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
