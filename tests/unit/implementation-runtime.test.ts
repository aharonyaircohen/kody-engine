import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadProfile } from "../../src/profile.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("Implementation runtime compiler", () => {
  it("compiles adapter config with Capability contract and Agent identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-runtime-"))
    roots.push(root)
    const capabilityDir = path.join(root, "capabilities", "build-knowledge-graph")
    const implementationDir = path.join(root, "implementations", "graphify-knowledge-graph")
    fs.mkdirSync(capabilityDir, { recursive: true })
    fs.mkdirSync(implementationDir, { recursive: true })
    fs.writeFileSync(
      path.join(capabilityDir, "definition.json"),
      JSON.stringify({
        id: "build-knowledge-graph",
        action: "build-knowledge-graph",
        purpose: "Build current project knowledge",
      }),
    )
    fs.writeFileSync(
      path.join(implementationDir, "definition.json"),
      JSON.stringify({
        id: "graphify-knowledge-graph",
        capabilityRef: {
          kind: "capability",
          id: "build-knowledge-graph",
        },
        compatibleCapabilityRevision: "contract-ref",
        type: "agent",
        agentRef: { kind: "agent", id: "knowledge-engineer" },
      }),
    )
    const runtimePath = path.join(implementationDir, "runtime.json")
    fs.writeFileSync(
      runtimePath,
      JSON.stringify({
        adapter: "kody-engine-profile",
        inputBindings: {},
        outputBindings: {},
        requirements: {},
        config: {
          role: "primitive",
          kind: "oneshot",
          inputs: [],
          claudeCode: {},
          cliTools: [],
          scripts: { preflight: [], postflight: [] },
        },
      }),
    )

    expect(loadProfile(runtimePath)).toMatchObject({
      name: "graphify-knowledge-graph",
      action: "build-knowledge-graph",
      describe: "Build current project knowledge",
      agent: "knowledge-engineer",
      role: "primitive",
    })
  })
})
