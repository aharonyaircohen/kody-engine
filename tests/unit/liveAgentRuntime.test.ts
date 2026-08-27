import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  getAgentState: vi.fn(),
  getRepoDoc: vi.fn(),
  listRepoDocs: vi.fn(),
  saveAgentState: vi.fn(),
}))
vi.mock("../../src/state-backend.js", () => ({ createStateBackendFromEnv: () => backend }))

import { loadLiveAgent } from "../../src/scripts/loadLiveAgent.js"
import { saveLiveAgentState } from "../../src/scripts/saveLiveAgentState.js"
import { resolveImplementation } from "../../src/registry.js"
import { loadProfile } from "../../src/profile.js"

const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function context(cwd: string) {
  return {
    cwd,
    args: { agent: "operations-agent", intent: "healthy-operations" },
    config: { github: { owner: "acme", repo: "widgets" }, agent: { model: "test" } },
    data: { jobAgent: "operations-agent" },
    output: { exitCode: 0 },
  } as never
}

describe("live Agent runtime", () => {
  it("uses a short silence timeout so abandoned decisions release their Loop lease", () => {
    const profilePath = resolveImplementation("live-agent")
    expect(profilePath).not.toBeNull()
    const profile = loadProfile(profilePath!)

    expect(profile.claudeCode.maxTurnTimeoutSec).toBe(180)
  })

  it("loads identity, primary Intent, effective guidance, capabilities, and AgentState", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "live-agent-"))
    roots.push(cwd)
    const dir = path.join(cwd, ".kody-engine", "definitions", "agents")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "operations-agent.md"),
      [
        "---",
        "primaryIntent: healthy-operations",
        "capabilities: [inspect, repair]",
        "---",
        "# Operations",
        "Keep systems healthy.",
      ].join("\n"),
    )
    backend.getAgentState.mockResolvedValue({
      state: {
        version: 1,
        agent: "operations-agent",
        revision: 4,
        cursor: "waiting",
        summary: "Waiting.",
        data: { run: 3 },
        updatedAt: "2026-08-19T00:00:00.000Z",
      },
    })
    backend.getRepoDoc.mockResolvedValue({
      kind: "intent:healthy-operations",
      doc: { body: "---\nagent: [*]\n---\nKeep production healthy." },
    })
    backend.listRepoDocs.mockImplementation(async (_tenant: string, prefix: string) => [
      { kind: `${prefix}one`, doc: { body: "---\nagent: [operations-agent]\n---\nRelevant guidance." } },
      { kind: `${prefix}other`, doc: { body: "---\nagent: [other-agent]\n---\nHidden guidance." } },
    ])
    const ctx = context(cwd)
    const profile = { claudeCode: { tools: [] } } as never

    await loadLiveAgent(ctx, profile)

    const data = (ctx as unknown as { data: Record<string, unknown> }).data
    expect(data).toMatchObject({
      liveAgentIntent: "Keep production healthy.",
      liveAgentPolicies: "Relevant guidance.",
      liveAgentConstraints: "Relevant guidance.",
      liveAgentContext: "Relevant guidance.",
      liveAgentCapabilities: "- inspect\n- repair",
      liveAgentPreviousRevision: 4,
    })
    expect((data.jobState as { state: unknown }).state).toMatchObject({ rev: 4, cursor: "waiting", data: { run: 3 } })
    expect(data.capabilityTools).toEqual(["start_capability", "read_latest_report", "reconcile_todo"])
  })

  it("persists the submitted continuation with optimistic revision protection", async () => {
    const ctx = context(process.cwd()) as unknown as { data: Record<string, unknown> }
    ctx.data.liveAgentSlug = "operations-agent"
    ctx.data.liveAgentPreviousRevision = 4
    ctx.data.nextJobState = { cursor: "checking", data: { run: 4 } }

    await saveLiveAgentState(ctx as never, {} as never, { finalText: "Started the next check." } as never)

    expect(backend.saveAgentState).toHaveBeenCalledWith(
      "acme/widgets",
      expect.objectContaining({
        agent: "operations-agent",
        revision: 5,
        cursor: "checking",
        summary: "Started the next check.",
        data: { run: 4 },
      }),
      4,
    )
    expect(ctx.data.capabilityOutput).toEqual({ cursor: "checking", data: { run: 4 } })
  })
})
