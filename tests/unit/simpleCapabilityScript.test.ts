import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadSimpleCapability } from "../../src/scripts/loadSimpleCapability.js"
import { parseSimpleCapabilityOutput } from "../../src/scripts/parseSimpleCapabilityOutput.js"
import { runSimpleCapabilityScript } from "../../src/scripts/runSimpleCapabilityScript.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function scriptedCapability(script: string): {
  cwd: string
  ctx: {
    cwd: string
    args: Record<string, unknown>
    data: Record<string, unknown>
    output: { exitCode?: number; reason?: string }
    skipAgent?: boolean
  }
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "simple-capability-script-"))
  roots.push(cwd)
  const dir = path.join(cwd, ".kody-engine", "definitions", "capabilities", "greet")
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true })
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true })
  fs.writeFileSync(path.join(dir, "instructions.md"), "Return a deterministic greeting.\n")
  fs.writeFileSync(
    path.join(dir, "contract.json"),
    JSON.stringify({
      execution: "script",
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      output: {
        type: "object",
        properties: { greeting: { type: "string" } },
        required: ["greeting"],
      },
    }),
  )
  fs.writeFileSync(path.join(dir, "tools", "run.sh"), script)
  return {
    cwd,
    ctx: {
      cwd,
      args: { capability: "greet", input: '{"name":"Ada"}' },
      data: {},
      output: {},
    },
  }
}

describe("script-backed simple Capability", () => {
  it("runs without an agent and returns the same validated Capability output shape", async () => {
    const { ctx } = scriptedCapability('#!/bin/sh\nprintf \'{"greeting":"Hello %s"}\' "$KODY_ARG_NAME"\n')

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)
    await parseSimpleCapabilityOutput(ctx as never, {} as never, null)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output.exitCode).toBeUndefined()
    expect(ctx.data.capabilityOutput).toEqual({ greeting: "Hello Ada" })
    expect(ctx.data.capabilityResults).toMatchObject([
      {
        status: "changed",
        facts: { greeting: "Hello Ada" },
      },
    ])
  })

  it("fails when the script does not return JSON", async () => {
    const { ctx } = scriptedCapability("#!/bin/sh\nprintf 'not-json'\n")

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output).toMatchObject({
      exitCode: 64,
      reason: expect.stringMatching(/valid JSON/i),
    })
  })

  it("rejects script output that violates the Capability contract", async () => {
    const { ctx } = scriptedCapability("#!/bin/sh\nprintf '{\"unexpected\":true}'\n")

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)
    await parseSimpleCapabilityOutput(ctx as never, {} as never, null)

    expect(ctx.output).toMatchObject({
      exitCode: 64,
      reason: expect.stringMatching(/greeting/i),
    })
  })

  it("propagates a non-zero script exit", async () => {
    const { ctx } = scriptedCapability("#!/bin/sh\nexit 7\n")

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)

    expect(ctx.skipAgent).toBe(true)
    expect(ctx.output).toMatchObject({
      exitCode: 7,
      reason: expect.stringMatching(/exited 7/i),
    })
  })
})
