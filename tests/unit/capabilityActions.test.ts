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
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n`)
}

function writeImplementation(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "implementations", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, inputs: [], ...profile }, null, 2))
}

describe("capability actions", () => {
  it("resolves folder capability action to its declared implementation", () => {
    process.chdir(root)
    writeFolderCapability("memorize", { action: "remember", implementation: "impl", agent: "kody" })

    expect(resolveCapabilityAction("remember")).toMatchObject({
      action: "remember",
      capability: "memorize",
      implementation: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder capability action to the capability slug and first implementation", () => {
    process.chdir(root)
    writeFolderCapability("ship", { implementations: ["impl"], agent: "kody" })

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "ship",
      implementation: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder capability execution to capability-tick", () => {
    process.chdir(root)
    writeFolderCapability("watch", { agent: "kody" })

    expect(resolveCapabilityAction("watch")).toMatchObject({
      action: "watch",
      capability: "watch",
      implementation: "capability-tick",
      source: "project-folder",
    })
  })

  it("uses capability-tick-scripted for scripted folder capabilities", () => {
    process.chdir(root)
    writeFolderCapability("scripted", { tickScript: "node tick.mjs" })

    expect(resolveCapabilityAction("scripted")).toMatchObject({
      action: "scripted",
      capability: "scripted",
      implementation: "capability-tick-scripted",
      source: "project-folder",
    })
  })

  it("keeps internal capability implementation profiles out of public actions", () => {
    process.chdir(root)
    writeFolderCapability("goal-scheduler", {
      internal: true,
      role: "watch",
      kind: "scheduled",
      schedule: "*/5 * * * *",
      inputs: [],
    })

    expect(resolveCapabilityAction("goal-scheduler")).toBeNull()
    expect(listCapabilityActions().map((action) => action.action)).not.toContain("goal-scheduler")
  })

  it("ignores legacy single-file markdown capabilities", () => {
    process.chdir(root)
    fs.mkdirSync(path.join(root, ".kody", "capabilities"), { recursive: true })
    fs.writeFileSync(
      path.join(root, ".kody", "capabilities", "legacy.md"),
      "---\naction: legacy\nimplementation: impl\nagent: kody\n---\n# Legacy\n",
    )

    expect(resolveCapabilityAction("legacy")).toBeNull()
  })

  it("resolves folder capability action before the same action on an implementation profile", () => {
    process.chdir(root)
    writeFolderCapability("daily-impl", { action: "ship", implementation: "impl", agent: "kody" })
    writeImplementation("direct-ship", {
      action: "ship",
      role: "utility",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveCapabilityAction("ship")).toMatchObject({
      action: "ship",
      capability: "daily-impl",
      implementation: "impl",
      source: "project-folder",
    })
  })

  it("does not resolve public actions declared directly on obsolete implementation profiles", () => {
    process.chdir(root)
    writeImplementation("direct-ship", {
      action: "ship",
      role: "utility",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveCapabilityAction("ship")).toBeNull()
  })

  it("ignores all direct implementation actions", () => {
    process.chdir(root)
    writeImplementation("direct-ship", {
      action: "ship",
      role: "utility",
      kind: "oneshot",
      describe: "Ship directly.",
    })
    writeImplementation("chatty", { action: "chatty", role: "chat" })
    writeImplementation("untyped", { action: "untyped", role: "utility" })
    writeImplementation("floating", { action: "floating", role: "utility", inputs: undefined })

    expect(resolveCapabilityAction("ship")).toBeNull()
    expect(resolveCapabilityAction("chatty")).toBeNull()
    expect(resolveCapabilityAction("untyped")).toBeNull()
    expect(resolveCapabilityAction("floating")).toBeNull()
  })

  it("lists built-in public actions from engine capability definitions", () => {
    const actions = listCapabilityActions().map((d) => d.action)
    expect(actions).toContain("run")
    expect(actions).toContain("agent-factory")
    expect(actions).toContain("agent-creator")
    expect(actions).toContain("goal-creator")
    expect(actions).toContain("loop-creator")
    expect(actions).toContain("workflow-creator")
    expect(actions).toContain("capability-creator")
  })
})
