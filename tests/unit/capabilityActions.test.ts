import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listCapabilityActions, resolveCapabilityAction } from "../../src/registry.js"

const originalCwd = process.cwd()
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-capability-actions-"))
  process.chdir(root)
})

afterEach(() => {
  process.chdir(originalCwd)
  fs.rmSync(root, { recursive: true, force: true })
})

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function writeSeparatedCapability(slug: string, action: string, implementationId: string): void {
  const capability = {
    id: slug,
    action,
    purpose: `Test ${action}`,
    inputSchema: { type: "object", additionalProperties: true },
    outputSchema: { type: "object", additionalProperties: true },
    effects: [],
    permissions: [],
    success: "success",
    failure: "failure",
  }
  const revision = createHash("sha256").update(canonical(capability)).digest("hex")
  const capabilityDir = path.join(root, ".kody-engine", "definitions", "capabilities", slug)
  const implementationDir = path.join(root, ".kody-engine", "definitions", "implementations", implementationId)
  fs.mkdirSync(capabilityDir, { recursive: true })
  fs.mkdirSync(implementationDir, { recursive: true })
  fs.writeFileSync(path.join(capabilityDir, "definition.json"), JSON.stringify(capability))
  fs.writeFileSync(path.join(capabilityDir, "capability.md"), `# ${slug}\n`)
  fs.writeFileSync(
    path.join(implementationDir, "definition.json"),
    JSON.stringify({
      id: implementationId,
      capabilityRef: { kind: "capability", id: slug },
      compatibleCapabilityRevision: revision,
      type: "script",
    }),
  )
  fs.writeFileSync(
    path.join(implementationDir, "runtime.json"),
    JSON.stringify({
      adapter: "kody-engine-profile",
      role: "utility",
      kind: "oneshot",
      describe: "Implementation fixture.",
      inputs: [],
      claudeCode: {
        model: "inherit",
        permissionMode: "default",
        maxTurns: 0,
        maxThinkingTokens: null,
        systemPromptAppend: null,
        tools: [],
        hooks: [],
        skills: [],
        commands: [],
        subagents: [],
        plugins: [],
        mcpServers: [],
      },
      cliTools: [],
      scripts: { preflight: [{ script: "skipAgent" }], postflight: [] },
    }),
  )
}

describe("capability actions", () => {
  it.skip("resolves a public action through its compatible Implementation", () => {
    writeSeparatedCapability("memorize", "remember", "memory-script")

    expect(resolveCapabilityAction("remember")).toMatchObject({
      action: "remember",
      capability: "memorize",
      implementation: "memory-script",
      source: "project-folder",
    })
  })

  it.skip("does not require Capability and Implementation ids to match", () => {
    writeSeparatedCapability("ship", "ship", "release-script")

    expect(resolveCapabilityAction("ship")).toMatchObject({
      capability: "ship",
      implementation: "release-script",
    })
  })

  it.skip("keeps Implementation runtime profiles out of public actions", () => {
    writeSeparatedCapability("ship", "ship", "release-script")
    expect(listCapabilityActions().map((entry) => entry.action)).toContain("ship")
    expect(listCapabilityActions().map((entry) => entry.action)).not.toContain("release-script")
  })

  it("ignores legacy single-file Capability definitions", () => {
    const capabilityRoot = path.join(root, ".kody-engine", "definitions", "capabilities")
    fs.mkdirSync(capabilityRoot, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityRoot, "legacy.md"),
      "---\naction: legacy\nimplementation: impl\n---\n# Legacy\n",
    )
    expect(resolveCapabilityAction("legacy")).toBeNull()
  })
})
