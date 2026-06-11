import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listDutyActions, resolveDutyAction } from "../../src/registry.js"

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-duty-actions-"))
  fs.mkdirSync(path.join(root, ".kody", "duties"), { recursive: true })
  fs.mkdirSync(path.join(root, ".kody", "executables", "impl"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".kody", "executables", "impl", "profile.json"),
    JSON.stringify({ name: "impl", inputs: [] }),
  )
})

afterEach(() => {
  process.chdir("/Users/aguy/projects/kody2")
  fs.rmSync(root, { recursive: true, force: true })
})

function writeMarkdownDuty(slug: string, frontmatter: string): void {
  fs.writeFileSync(path.join(root, ".kody", "duties", `${slug}.md`), `---\n${frontmatter}\n---\n# ${slug}\n`)
}

function writeFolderDuty(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
}

describe("duty actions", () => {
  it("resolves a markdown duty action to its declared executable", () => {
    process.chdir(root)
    writeMarkdownDuty("memorize", "action: remember\nexecutable: impl\nstaff: kody")

    expect(resolveDutyAction("remember")).toMatchObject({
      action: "remember",
      duty: "memorize",
      executable: "impl",
      source: "project-markdown",
    })
  })

  it("defaults a markdown duty action to the duty slug and single executable", () => {
    process.chdir(root)
    writeMarkdownDuty("memorize", "executables: impl\nstaff: kody")

    expect(resolveDutyAction("memorize")).toMatchObject({
      action: "memorize",
      duty: "memorize",
      executable: "impl",
    })
  })

  it("uses duty-tick plus --duty for a markdown duty with no implementation executable", () => {
    process.chdir(root)
    writeMarkdownDuty("triage", "action: triage\nstaff: kody")

    expect(resolveDutyAction("triage")).toMatchObject({
      action: "triage",
      duty: "triage",
      executable: "duty-tick",
      cliArgs: { duty: "triage" },
    })
  })

  it("resolves a folder duty action before a same-named executable", () => {
    process.chdir(root)
    writeFolderDuty("daily-impl", { action: "ship", executable: "impl", staff: "kody" })

    expect(resolveDutyAction("ship")).toMatchObject({
      action: "ship",
      duty: "daily-impl",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("lists built-in public actions from engine duty definitions", () => {
    const actions = listDutyActions().map((d) => d.action)
    expect(actions).toContain("run")
    expect(actions).toContain("fix")
    expect(actions).toContain("resolve")
  })
})
