/**
 * Unit tests for `loadJobFromFile` — the preflight that loads a file-based
 * agentResponsibility (body, state, agent identity) into `ctx.data`.
 *
 * Focus here: the `mentions` profile field is read alongside `agent`
 * and exposed to the agentResponsibility prompt as a ready-to-insert `ctx.data.mentions`
 * string ("@a @b"), or "" when absent. Uses the local-file state backend so
 * the test never touches GitHub.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/agent-actions/types.js"
import type { KodyConfig } from "../../src/config.js"
import { loadJobFromFile } from "../../src/scripts/loadJobFromFile.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-job-"))
  fs.mkdirSync(path.join(tmp, ".kody", "agent-responsibilities"), { recursive: true })
  fs.mkdirSync(path.join(tmp, ".kody", "agents"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeAgentResponsibility(
  slug: string,
  profile: Record<string, unknown>,
  body = "# AgentResponsibility\nbody",
): void {
  const dir = path.join(tmp, ".kody", "agent-responsibilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "agent-responsibility.md"), body)
}

function writeAgent(slug: string, body = "# Agent\nidentity"): void {
  fs.writeFileSync(path.join(tmp, ".kody", "agents", `${slug}.md`), body)
}

function ctxFor(slug: string): Context {
  const config: KodyConfig = {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
  return {
    args: { job: slug },
    cwd: tmp,
    config,
    data: {},
    output: { exitCode: 0 },
  } as unknown as Context
}

const PROFILE = {} as unknown as Profile

describe("loadJobFromFile mentions", () => {
  it("formats a `mentions: a, b` list into a ready-to-insert '@a @b' string", async () => {
    writeAgent("kody")
    writeAgentResponsibility("changelog-verify", { agent: "kody", mentions: ["a", "b"] })

    const ctx = ctxFor("changelog-verify")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.mentions).toBe("@a @b")
  })

  it("sets ctx.data.mentions to '' when the agentResponsibility declares no mentions", async () => {
    writeAgent("kody")
    writeAgentResponsibility("broad-sweep", { agent: "kody" })

    const ctx = ctxFor("broad-sweep")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.mentions).toBe("")
  })
})

describe("loadJobFromFile locked-toolbox (tools:)", () => {
  function lockedProfile(): Profile {
    return { claudeCode: { tools: [] as string[] } } as unknown as Profile
  }

  it("revokes Bash/Read and locks allowedTools to the declared kody-agentResponsibility tools + submit_state", async () => {
    writeAgent("cto")
    writeAgentResponsibility("dev-ci-health", {
      agent: "cto",
      tools: ["read_check_runs", "ensure_issue", "dispatch_workflow", "ensure_comment"],
    })

    const ctx = ctxFor("dev-ci-health")
    const profile = lockedProfile()
    await loadJobFromFile(ctx, profile, {})

    expect(ctx.data.agentResponsibilityTools).toEqual([
      "read_check_runs",
      "ensure_issue",
      "dispatch_workflow",
      "ensure_comment",
    ])
    const lockedTools = (profile as unknown as { claudeCode: { tools: string[] } }).claudeCode.tools
    expect(lockedTools).toEqual([
      "mcp__kody-agentResponsibility__read_check_runs",
      "mcp__kody-agentResponsibility__ensure_issue",
      "mcp__kody-agentResponsibility__dispatch_workflow",
      "mcp__kody-agentResponsibility__ensure_comment",
      "mcp__kody-submit__submit_state",
    ])
    // The raw escape hatches are gone.
    expect(lockedTools).not.toContain("Bash")
    expect(lockedTools).not.toContain("Read")
    expect(ctx.data.promptTemplate).toBe("prompts/locked.md")
  })

  it("throws if a agentResponsibility declares a tool not in the kody-agentResponsibility palette", async () => {
    writeAgent("cto")
    writeAgentResponsibility("bad", { agent: "cto", tools: ["read_check_runs", "make_coffee"] })

    await expect(loadJobFromFile(ctxFor("bad"), lockedProfile(), {})).rejects.toThrow(/make_coffee/)
  })
})

describe("loadJobFromFile body {{mentions}} substitution", () => {
  it("replaces {{mentions}} inside the agentResponsibility body with the resolved handles", async () => {
    writeAgent("kody")
    writeAgentResponsibility(
      "docs-readme",
      { agent: "kody", mentions: ["a", "b"] },
      "# AgentResponsibility\n{{mentions}} please review",
    )

    const ctx = ctxFor("docs-readme")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.jobIntent).toContain("@a @b please review")
    expect(ctx.data.jobIntent).not.toContain("{{mentions}}")
  })

  it("tolerates inner whitespace and renders empty when no mentions are declared", async () => {
    writeAgent("kody")
    writeAgentResponsibility("docs-code", { agent: "kody" }, "line {{ mentions }} end")

    const ctx = ctxFor("docs-code")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.jobIntent).toBe("line  end")
    expect(ctx.data.jobIntent).not.toContain("mentions")
  })
})

describe("loadJobFromFile agentResponsibility-noun aliases (Phase 1 rename)", () => {
  it("populates agentResponsibilitySlug/agentResponsibilityTitle from the agentResponsibility folder, mirroring jobSlug/jobTitle", async () => {
    writeAgent("kody")
    writeAgentResponsibility("stale-prs", { agent: "kody" }, "# Stale PR Watcher\nbody text")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "agent-responsibility-tick" }, {})

    expect(ctx.data.agentResponsibilitySlug).toBe("stale-prs")
    expect(ctx.data.agentResponsibilityTitle).toBe("Stale PR Watcher")
    // Backwards compat: legacy fields still populated for the kody-job-next-state
    // fence label and existing prompt templates.
    expect(ctx.data.jobSlug).toBe("stale-prs")
    expect(ctx.data.jobTitle).toBe("Stale PR Watcher")
  })

  it("populates agentSlug/agentTitle from the agent file, mirroring agentSlug/agentTitle", async () => {
    writeAgent("kody", "# Kody — root agent")
    writeAgentResponsibility("stale-prs", { agent: "kody" }, "# Stale PR Watcher")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "agent-responsibility-tick" }, {})

    expect(ctx.data.agentSlug).toBe("kody")
    expect(ctx.data.agentTitle).toBe("Kody — root agent")
    // Legacy fields still populated.
    expect(ctx.data.agentSlug).toBe("kody")
    expect(ctx.data.agentTitle).toBe("Kody — root agent")
  })

  it("populates agentActionSlug from profile.name", async () => {
    writeAgent("kody")
    writeAgentResponsibility("stale-prs", { agent: "kody" }, "# Stale PR Watcher")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "agent-responsibility-tick" }, {})

    expect(ctx.data.agentActionSlug).toBe("agent-responsibility-tick")
  })

  it("populates agentResponsibilitySchedule from the runtime job schedule", async () => {
    writeAgent("kody")
    writeAgentResponsibility("stale-prs", { agent: "kody" }, "# Stale PR Watcher")

    const ctx = ctxFor("stale-prs")
    ctx.data.jobSchedule = "1h"
    await loadJobFromFile(ctx, { ...PROFILE, name: "agent-responsibility-tick" }, {})

    expect(ctx.data.agentResponsibilitySchedule).toBe("1h")
  })

  it("leaves agentSlug empty when the agentResponsibility has no agent declared", async () => {
    writeAgentResponsibility("orphan", {}, "# Orphan AgentResponsibility\nno agent")

    const ctx = ctxFor("orphan")
    await loadJobFromFile(ctx, { ...PROFILE, name: "agent-responsibility-tick" }, {})

    expect(ctx.data.agentSlug).toBe("")
    expect(ctx.data.agentTitle).toBe("")
    expect(ctx.data.agentSlug).toBe("")
    expect(ctx.data.agentTitle).toBe("")
  })
})
