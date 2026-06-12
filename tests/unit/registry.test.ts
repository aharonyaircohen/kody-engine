import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  builtinExecutableNames,
  hasExecutable,
  isBuiltinExecutable,
  isSafeName,
  listBuiltinJobs,
  listExecutables,
  parseGenericFlags,
} from "../../src/registry.js"

function mkFixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody-registry-"))
}

function writeProfile(root: string, name: string, body: object = {}): void {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(body))
}

describe("registry: builtin executables (folder-duty shadow protection)", () => {
  it("detects the engine-bundled executables by name", () => {
    const names = builtinExecutableNames()
    // a sample of known engine builtins
    expect(names.has("run")).toBe(true)
    expect(names.has("merge")).toBe(true)
    expect(names.has("duty-scheduler")).toBe(true)
  })

  it("isBuiltinExecutable is true for builtins, false for custom names", () => {
    expect(isBuiltinExecutable("run")).toBe(true)
    expect(isBuiltinExecutable("merge")).toBe(true)
    expect(isBuiltinExecutable("a-custom-consumer-duty-xyz")).toBe(false)
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

describe("registry: listBuiltinJobs (folder shape)", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-builtin-jobs-"))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function writeFolder(slug: string, opts: { withBody?: boolean; withProfile?: boolean } = {}): void {
    const dir = path.join(root, slug)
    fs.mkdirSync(dir, { recursive: true })
    if (opts.withProfile !== false) fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug }))
    if (opts.withBody !== false) fs.writeFileSync(path.join(dir, "duty.md"), `# ${slug}\n`)
  }

  it("discovers a folder with both profile.json and duty.md", () => {
    writeFolder("watch-stale-prs")
    const jobs = listBuiltinJobs(root)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.slug).toBe("watch-stale-prs")
    expect(jobs[0]!.dir).toBe(path.join(root, "watch-stale-prs"))
    expect(jobs[0]!.profilePath).toBe(path.join(root, "watch-stale-prs", "profile.json"))
    expect(jobs[0]!.bodyPath).toBe(path.join(root, "watch-stale-prs", "duty.md"))
  })

  it("skips a folder missing profile.json", () => {
    writeFolder("incomplete", { withProfile: false })
    expect(listBuiltinJobs(root)).toEqual([])
  })

  it("skips a folder missing duty.md", () => {
    writeFolder("incomplete", { withBody: false })
    expect(listBuiltinJobs(root)).toEqual([])
  })

  it("ignores a legacy .md file", () => {
    fs.writeFileSync(path.join(root, "legacy-duty.md"), "# legacy\n")
    expect(listBuiltinJobs(root)).toEqual([])
  })

  it("returns an empty list when the root is absent", () => {
    fs.rmSync(root, { recursive: true, force: true })
    expect(listBuiltinJobs(root)).toEqual([])
  })

  it("skips hidden / underscore-prefixed entries", () => {
    writeFolder("real")
    writeFolder("_draft")
    fs.mkdirSync(path.join(root, ".hidden"), { recursive: true })
    fs.writeFileSync(path.join(root, ".hidden", "profile.json"), "{}")
    fs.writeFileSync(path.join(root, ".hidden", "duty.md"), "# hidden\n")
    expect(listBuiltinJobs(root).map((j) => j.slug)).toEqual(["real"])
  })
})
