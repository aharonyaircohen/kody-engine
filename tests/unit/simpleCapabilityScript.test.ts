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

function scriptedCapability(
  script: string,
  options: { connections?: string[]; secrets?: string[]; timeoutMs?: number; output?: Record<string, unknown> } = {},
): {
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
      ...(options.connections ? { connections: options.connections } : {}),
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      output: options.output ?? {
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
  it("loads the exact Connection ids declared by a trusted script", async () => {
    const { ctx } = scriptedCapability("#!/bin/sh\nprintf '{}\n'\n", {
      connections: ["facebook-main"],
      secrets: ["FACEBOOK_PAGE_ACCESS_TOKEN"],
    })

    await loadSimpleCapability(ctx as never, {} as never)

    expect(ctx.data.capabilityConnectionIds).toEqual(["facebook-main"])
  })

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

  it("passes repository Engine configuration through the trusted script boundary", async () => {
    const { ctx } = scriptedCapability(
      '#!/bin/sh\nprintf \'{"greeting":"%s -> %s"}\' "$KODY_CFG_GIT_DEFAULTBRANCH" "$KODY_CFG_RELEASE_RELEASEBRANCH"\n',
    )
    ;(ctx as typeof ctx & { config: Record<string, unknown> }).config = {
      git: { defaultBranch: "dev" },
      release: { releaseBranch: "main" },
    }

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)
    await parseSimpleCapabilityOutput(ctx as never, {} as never, null)

    expect(ctx.data.capabilityOutput).toEqual({ greeting: "dev -> main" })
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

  it("passes only explicitly declared Capability secrets to the script", async () => {
    const priorAllowed = process.env.KODY_TEST_ALLOWED_SECRET
    const priorDenied = process.env.KODY_TEST_DENIED_SECRET
    process.env.KODY_TEST_ALLOWED_SECRET = "allowed-value"
    process.env.KODY_TEST_DENIED_SECRET = "denied-value"
    try {
      const { ctx } = scriptedCapability(
        '#!/bin/sh\nprintf \'{"allowed":"%s","denied":"%s"}\' "$' +
          '{KODY_TEST_ALLOWED_SECRET:-}" "$' +
          '{KODY_TEST_DENIED_SECRET:-}"\n',
        {
          secrets: ["KODY_TEST_ALLOWED_SECRET"],
          output: {
            type: "object",
            properties: {
              allowed: { type: "string" },
              denied: { type: "string" },
            },
            required: ["allowed", "denied"],
          },
        },
      )

      await loadSimpleCapability(ctx as never, {} as never)
      await runSimpleCapabilityScript(ctx as never, {} as never)

      expect(ctx.data.capabilityScriptOutput).toEqual({
        allowed: "allowed-value",
        denied: "",
      })
    } finally {
      if (priorAllowed === undefined) delete process.env.KODY_TEST_ALLOWED_SECRET
      else process.env.KODY_TEST_ALLOWED_SECRET = priorAllowed
      if (priorDenied === undefined) delete process.env.KODY_TEST_DENIED_SECRET
      else process.env.KODY_TEST_DENIED_SECRET = priorDenied
    }
  })

  it("preserves a structured Capability result returned by a script", async () => {
    const structuredResult = {
      version: 1,
      status: "fail",
      summary: "Production deployment failed",
      facts: {},
      artifacts: [],
      missingEvidence: ["productionDeployed"],
      blockers: ["Production deployment failed"],
    }
    const { ctx } = scriptedCapability(`#!/bin/sh\nprintf '%s' '${JSON.stringify(structuredResult)}'\n`, {
      output: { type: "object" },
    })

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)
    await parseSimpleCapabilityOutput(ctx as never, {} as never, null)

    expect(ctx.data.capabilityResults).toEqual([structuredResult])
    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toBe("Production deployment failed")
  })

  it("accepts the standard Capability result marker alongside script logs", async () => {
    const structuredResult = {
      version: 1,
      status: "pass",
      summary: "Promotion PR opened",
      facts: { promotionPr: 992 },
      artifacts: [],
      missingEvidence: [],
      blockers: [],
    }
    const { ctx } = scriptedCapability(
      `#!/bin/sh\nprintf 'opening promotion\\nKODY_CAPABILITY_RESULT=%s\\n' '${JSON.stringify(structuredResult)}'\n`,
      { output: { type: "object" } },
    )

    await loadSimpleCapability(ctx as never, {} as never)
    await runSimpleCapabilityScript(ctx as never, {} as never)
    await parseSimpleCapabilityOutput(ctx as never, {} as never, null)

    expect(ctx.data.capabilityResults).toEqual([structuredResult])
  })
})
