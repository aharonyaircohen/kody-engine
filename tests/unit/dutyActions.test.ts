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

function writeExecutable(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "executables", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, inputs: [], ...profile }, null, 2))
}

describe("duty actions", () => {
  it("resolves folder duty action to its declared executable", () => {
    process.chdir(root)
    writeFolderDuty("memorize", { action: "remember", executable: "impl", staff: "kody" })

    expect(resolveDutyAction("remember")).toMatchObject({
      action: "remember",
      duty: "memorize",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder duty action to the duty slug and first executable", () => {
    process.chdir(root)
    writeFolderDuty("ship", { executables: ["impl"], staff: "kody" })

    expect(resolveDutyAction("ship")).toMatchObject({
      action: "ship",
      duty: "ship",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder duty execution to duty-tick", () => {
    process.chdir(root)
    writeFolderDuty("watch", { staff: "kody" })

    expect(resolveDutyAction("watch")).toMatchObject({
      action: "watch",
      duty: "watch",
      executable: "duty-tick",
      source: "project-folder",
    })
  })

  it("uses duty-tick-scripted for scripted folder duties", () => {
    process.chdir(root)
    writeFolderDuty("scripted", { tickScript: "node tick.mjs" })

    expect(resolveDutyAction("scripted")).toMatchObject({
      action: "scripted",
      duty: "scripted",
      executable: "duty-tick-scripted",
      source: "project-folder",
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

  it("resolves folder duty action before the same action on an executable profile", () => {
    process.chdir(root)
    writeFolderDuty("daily-impl", { action: "ship", executable: "impl", staff: "kody" })
    writeExecutable("direct-ship", {
      action: "ship",
      role: "utility",
      capabilityKind: "act",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveDutyAction("ship")).toMatchObject({
      action: "ship",
      duty: "daily-impl",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("resolves public action declared directly on a typed executable profile", () => {
    process.chdir(root)
    writeExecutable("direct-ship", {
      action: "ship",
      role: "utility",
      capabilityKind: "act",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveDutyAction("ship")).toMatchObject({
      action: "ship",
      duty: "direct-ship",
      executable: "direct-ship",
      source: "project-executable",
    })
  })

  it("ignores direct executable actions that are not typed engine profiles", () => {
    process.chdir(root)
    writeExecutable("chatty", { action: "chatty", role: "chat", capabilityKind: "act" })
    writeExecutable("untyped", { action: "untyped", role: "utility" })
    writeExecutable("floating", { action: "floating", role: "utility", capabilityKind: "act", inputs: undefined })

    expect(resolveDutyAction("chatty")).toBeNull()
    expect(resolveDutyAction("untyped")).toBeNull()
    expect(resolveDutyAction("floating")).toBeNull()
  })

  it("lists built-in public actions from engine duty definitions", () => {
    const actions = listDutyActions().map((d) => d.action)
    expect(actions).toContain("run")
    expect(actions).toContain("fix")
    expect(actions).toContain("resolve")
  })
})
