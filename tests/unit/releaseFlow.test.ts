import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bumpVersion, generateChangelog, prependChangelog, updateVersionInFile } from "../../src/scripts/releaseFlow.js"

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kody2-release-"))
}

function initGit(dir: string): void {
  execFileSync("git", ["init", "--initial-branch=main", "--quiet", dir], { stdio: "pipe" })
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"], { stdio: "pipe" })
  execFileSync("git", ["-C", dir, "config", "user.name", "t"], { stdio: "pipe" })
}

describe("release: bumpVersion", () => {
  it("patches", () => expect(bumpVersion("0.1.2", "patch")).toBe("0.1.3"))
  it("minor resets patch", () => expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0"))
  it("major resets minor and patch", () => expect(bumpVersion("1.2.3", "major")).toBe("2.0.0"))
  it("ignores suffix", () => expect(bumpVersion("0.1.2-rc.1", "patch")).toBe("0.1.3"))
  it("throws on bad input", () => expect(() => bumpVersion("x", "patch")).toThrow(/cannot parse/))
})

describe("release: updateVersionInFile", () => {
  let dir: string
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("updates the first version string in JSON", () => {
    dir = tmp()
    fs.writeFileSync(path.join(dir, "package.json"), `{ "name": "x", "version": "0.1.0" }`)
    expect(updateVersionInFile("package.json", "0.2.0", dir)).toBe(true)
    const after = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"))
    expect(after.version).toBe("0.2.0")
  })

  it("returns false when file missing", () => {
    dir = tmp()
    expect(updateVersionInFile("missing.json", "0.2.0", dir)).toBe(false)
  })

  it("returns false when no version field present", () => {
    dir = tmp()
    fs.writeFileSync(path.join(dir, "noversion.json"), `{ "name": "x" }`)
    expect(updateVersionInFile("noversion.json", "0.2.0", dir)).toBe(false)
  })
})

describe("release: generateChangelog", () => {
  let dir: string
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("groups conventional commits by type", () => {
    dir = tmp()
    initGit(dir)
    fs.writeFileSync(path.join(dir, "a"), "1")
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "commit", "--no-gpg-sign", "-m", "feat: add a"], { stdio: "pipe" })
    fs.writeFileSync(path.join(dir, "b"), "2")
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "commit", "--no-gpg-sign", "-m", "fix(core): fix b"], { stdio: "pipe" })
    fs.writeFileSync(path.join(dir, "c"), "3")
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "commit", "--no-gpg-sign", "-m", "docs: add notes"], { stdio: "pipe" })

    const cl = generateChangelog(dir, "0.2.0", null)
    expect(cl).toMatch(/## v0\.2\.0/)
    expect(cl).toMatch(/### Features\n- add a/)
    expect(cl).toMatch(/### Fixes\n- fix b/)
    expect(cl).toMatch(/### Docs\n- add notes/)
  })

  it("skips prior release commits", () => {
    dir = tmp()
    initGit(dir)
    fs.writeFileSync(path.join(dir, "a"), "1")
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "commit", "--no-gpg-sign", "-m", "chore: release v0.1.0"], { stdio: "pipe" })
    fs.writeFileSync(path.join(dir, "b"), "2")
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "commit", "--no-gpg-sign", "-m", "feat: new thing"], { stdio: "pipe" })

    const cl = generateChangelog(dir, "0.2.0", null)
    expect(cl).not.toMatch(/release v0\.1\.0/)
    expect(cl).toMatch(/new thing/)
  })

  it("falls back to 'no notable commits' when empty", () => {
    dir = tmp()
    initGit(dir)
    fs.writeFileSync(path.join(dir, "a"), "1")
    execFileSync("git", ["-C", dir, "add", "."], { stdio: "pipe" })
    execFileSync("git", ["-C", dir, "commit", "--no-gpg-sign", "-m", "chore: release v0.1.0"], { stdio: "pipe" })
    const cl = generateChangelog(dir, "0.2.0", null)
    expect(cl).toMatch(/No notable commits/)
  })
})

describe("release: prependChangelog", () => {
  let dir: string
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("creates CHANGELOG.md with header when absent", () => {
    dir = tmp()
    prependChangelog(dir, "## v0.2.0\n\n- new thing\n")
    const content = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")
    expect(content).toMatch(/# Changelog/)
    expect(content).toMatch(/## v0\.2\.0/)
  })

  it("inserts after existing # Changelog header", () => {
    dir = tmp()
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "# Changelog\n\n## v0.1.0\n- first\n")
    prependChangelog(dir, "## v0.2.0\n\n- newer\n")
    const content = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")
    // v0.2.0 should appear before v0.1.0
    expect(content.indexOf("v0.2.0")).toBeLessThan(content.indexOf("v0.1.0"))
  })

  it("prepends full header when existing file has no # Changelog", () => {
    dir = tmp()
    fs.writeFileSync(path.join(dir, "CHANGELOG.md"), "random stuff\n")
    prependChangelog(dir, "## v0.2.0\n\n")
    const content = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf-8")
    expect(content.startsWith("# Changelog")).toBe(true)
  })
})
