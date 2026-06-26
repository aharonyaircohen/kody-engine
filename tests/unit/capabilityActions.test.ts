import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listCapabilityActions, resolveCapabilityAction } from "../../src/registry.js"

const originalCwd = process.cwd()
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-actions-"))
  fs.mkdirSync(path.join(root, ".kody", "capabilities", "impl"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".kody", "capabilities", "impl", "profile.json"),
    JSON.stringify({
      name: "impl",
      role: "utility",
      capabilityKind: "act",
      kind: "oneshot",
      describe: "Implementation fixture.",
      inputs: [],
    }),
  )
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(root, { recursive: true, force: true })
})

function writeFolderCapability(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "capabilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "profile.json"),
    JSON.stringify({ name: slug, capabilityKind: "act", ...profile }, null, 2),
  )
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n`)
}

function writeExecutable(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "executables", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, inputs: [], ...profile }, null, 2))
}

describe("capability actions", () => {
  it("resolves folder capability action to its declared executable", () => {
    process.chdir(root)
    writeFolderCapability("memorize", { action: "remember", implementation: "impl", agent: "kody" })

    expect(resolveCapabilityAction("remember")).toMatchObject({
      action: "remember",
      capability: "memorize",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder capability action to the capability slug and first executable", () => {
    process.chdir(root)
    writeFolderCapability("ship", { implementations: ["impl"], agent: "kody" })

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "ship",
      executable: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder capability execution to capability-tick", () => {
    process.chdir(root)
    writeFolderCapability("watch", { agent: "kody" })

    expect(resolveCapabilityAction("watch")).toMatchObject({
      action: "watch",
      capability: "watch",
      executable: "capability-tick",
      source: "project-folder",
    })
  })

  it("uses capability-tick-scripted for scripted folder capabilities", () => {
    process.chdir(root)
    writeFolderCapability("scripted", { tickScript: "node tick.mjs" })

    expect(resolveCapabilityAction("scripted")).toMatchObject({
      action: "scripted",
      capability: "scripted",
      executable: "capability-tick-scripted",
      source: "project-folder",
    })
  })

  it("ignores legacy single-file markdown capabilities", () => {
    process.chdir(root)
    fs.mkdirSync(path.join(root, ".kody", "capabilities"), { recursive: true })
    fs.writeFileSync(
      path.join(root, ".kody", "capabilities", "legacy.md"),
      "---\naction: legacy\nexecutable: impl\nagent: kody\n---\n# Legacy\n",
    )

    expect(resolveCapabilityAction("legacy")).toBeNull()
  })

  it("resolves folder capability action before the same action on an executable profile", () => {
    process.chdir(root)
    writeFolderCapability("daily-impl", { action: "ship", implementation: "impl", agent: "kody" })
    writeExecutable("direct-ship", {
      action: "ship",
      role: "utility",
      capabilityKind: "act",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "daily-impl",
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

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "direct-ship",
      executable: "direct-ship",
      source: "project-executable",
    })
  })

  it("ignores direct executable actions that are not typed engine profiles", () => {
    process.chdir(root)
    writeExecutable("chatty", { action: "chatty", role: "chat", capabilityKind: "act" })
    writeExecutable("untyped", { action: "untyped", role: "utility" })
    writeExecutable("floating", { action: "floating", role: "utility", capabilityKind: "act", inputs: undefined })

    expect(resolveCapabilityAction("chatty")).toBeNull()
    expect(resolveCapabilityAction("untyped")).toBeNull()
    expect(resolveCapabilityAction("floating")).toBeNull()
  })

  it("lists built-in public actions from engine capability definitions", () => {
    const actions = listCapabilityActions().map((d) => d.action)
    expect(actions).toContain("run")
    expect(actions).toContain("agent-factory")
  })
})
