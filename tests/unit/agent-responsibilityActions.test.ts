import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listAgentResponsibilityActions, resolveAgentResponsibilityAction } from "../../src/registry.js"

const originalCwd = process.cwd()
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-agentResponsibility-actions-"))
  fs.mkdirSync(path.join(root, ".kody", "agent-responsibilities"), { recursive: true })
  fs.mkdirSync(path.join(root, ".kody", "agent-actions", "impl"), { recursive: true })
  fs.writeFileSync(
    path.join(root, ".kody", "agent-actions", "impl", "profile.json"),
    JSON.stringify({ name: "impl", inputs: [] }),
  )
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(root, { recursive: true, force: true })
})

function writeFolderAgentResponsibility(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "agent-responsibilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), `# ${slug}\n`)
}

function writeAgentAction(slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(root, ".kody", "agent-actions", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, inputs: [], ...profile }, null, 2))
}

describe("agentResponsibility actions", () => {
  it("resolves folder agentResponsibility action to its declared agentAction", () => {
    process.chdir(root)
    writeFolderAgentResponsibility("memorize", { action: "remember", agentAction: "impl", agent: "kody" })

    expect(resolveAgentResponsibilityAction("remember")).toMatchObject({
      action: "remember",
      agentResponsibility: "memorize",
      agentAction: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder agentResponsibility action to the agentResponsibility slug and first agentAction", () => {
    process.chdir(root)
    writeFolderAgentResponsibility("ship", { agentActions: ["impl"], agent: "kody" })

    expect(resolveAgentResponsibilityAction("ship")).toMatchObject({
      action: "ship",
      agentResponsibility: "ship",
      agentAction: "impl",
      source: "project-folder",
    })
  })

  it("defaults folder agentResponsibility execution to agent-responsibility-tick", () => {
    process.chdir(root)
    writeFolderAgentResponsibility("watch", { agent: "kody" })

    expect(resolveAgentResponsibilityAction("watch")).toMatchObject({
      action: "watch",
      agentResponsibility: "watch",
      agentAction: "agent-responsibility-tick",
      source: "project-folder",
    })
  })

  it("uses agent-responsibility-tick-scripted for scripted folder agentResponsibilities", () => {
    process.chdir(root)
    writeFolderAgentResponsibility("scripted", { tickScript: "node tick.mjs" })

    expect(resolveAgentResponsibilityAction("scripted")).toMatchObject({
      action: "scripted",
      agentResponsibility: "scripted",
      agentAction: "agent-responsibility-tick-scripted",
      source: "project-folder",
    })
  })

  it("ignores legacy single-file markdown agentResponsibilities", () => {
    process.chdir(root)
    fs.writeFileSync(
      path.join(root, ".kody", "agent-responsibilities", "legacy.md"),
      "---\naction: legacy\nexecutable: impl\nagent: kody\n---\n# Legacy\n",
    )

    expect(resolveAgentResponsibilityAction("legacy")).toBeNull()
  })

  it("resolves folder agentResponsibility action before the same action on an agentAction profile", () => {
    process.chdir(root)
    writeFolderAgentResponsibility("daily-impl", { action: "ship", agentAction: "impl", agent: "kody" })
    writeAgentAction("direct-ship", {
      action: "ship",
      role: "utility",
      capabilityKind: "act",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveAgentResponsibilityAction("ship")).toMatchObject({
      action: "ship",
      agentResponsibility: "daily-impl",
      agentAction: "impl",
      source: "project-folder",
    })
  })

  it("resolves public action declared directly on a typed agentAction profile", () => {
    process.chdir(root)
    writeAgentAction("direct-ship", {
      action: "ship",
      role: "utility",
      capabilityKind: "act",
      kind: "oneshot",
      describe: "Ship directly.",
    })

    expect(resolveAgentResponsibilityAction("ship")).toMatchObject({
      action: "ship",
      agentResponsibility: "direct-ship",
      agentAction: "direct-ship",
      source: "project-agentAction",
    })
  })

  it("ignores direct agentAction actions that are not typed engine profiles", () => {
    process.chdir(root)
    writeAgentAction("chatty", { action: "chatty", role: "chat", capabilityKind: "act" })
    writeAgentAction("untyped", { action: "untyped", role: "utility" })
    writeAgentAction("floating", { action: "floating", role: "utility", capabilityKind: "act", inputs: undefined })

    expect(resolveAgentResponsibilityAction("chatty")).toBeNull()
    expect(resolveAgentResponsibilityAction("untyped")).toBeNull()
    expect(resolveAgentResponsibilityAction("floating")).toBeNull()
  })

  it("lists built-in public actions from engine agentResponsibility definitions", () => {
    const actions = listAgentResponsibilityActions().map((d) => d.action)
    expect(actions).toContain("run")
    expect(actions).toContain("fix")
    expect(actions).toContain("resolve")
  })
})
