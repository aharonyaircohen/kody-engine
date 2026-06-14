import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listDutyActions, resolveDutyAction } from "../../src/registry.js"

const originalCwd = process.cwd()
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
  process.chdir(originalCwd)
  fs.rmSync(root, { recursive: true, force: true })
})

function writeFolderDuty(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "duty.md"), `# ${slug}\n`)
}

describe("duty actions", () => {
  it("resolves a folder duty action to its declared executable", () => {
    process.chdir(root)
    writeFolderDuty("memorize", { action: "remember", executable: "impl", staff: "kody" })

    expect(resolveDutyAction("remember")).toMatchObject({
      action: "remember",
      duty: "memorize",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("defaults a folder duty action to the duty slug and single executable", () => {
    process.chdir(root)
    writeFolderDuty("memorize", { executables: ["impl"], staff: "kody" })

    expect(resolveDutyAction("memorize")).toMatchObject({
      action: "memorize",
      duty: "memorize",
      executable: "impl",
    })
  })

  it("uses duty-tick plus --duty for a folder duty with no implementation executable", () => {
    process.chdir(root)
    writeFolderDuty("triage", { action: "triage", staff: "kody" })

    expect(resolveDutyAction("triage")).toMatchObject({
      action: "triage",
      duty: "triage",
      executable: "duty-tick",
      cliArgs: { duty: "triage" },
    })
  })

  it("ignores legacy single-file markdown duties", () => {
    process.chdir(root)
    fs.writeFileSync(
      path.join(root, ".kody", "duties", "legacy.md"),
      "---\naction: legacy\nexecutable: impl\nstaff: kody\n---\n# Legacy\n",
    )

    expect(resolveDutyAction("legacy")).toBeNull()
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
