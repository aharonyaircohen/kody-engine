/**
 * Unit tests for `loadJobFromFile` — the preflight that loads a file-based
 * duty (body, state, agent identity) into `ctx.data`.
 *
 * Focus here: the `mentions` profile field is read alongside `agent`
 * and exposed to the duty prompt as a ready-to-insert `ctx.data.mentions`
 * string ("@a @b"), or "" when absent. Uses the local-file state backend so
 * the test never touches GitHub.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadJobFromFile } from "../../src/scripts/loadJobFromFile.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "load-job-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
  fs.mkdirSync(path.join(tmp, ".kody", "agents"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function writeDuty(slug: string, profile: Record<string, unknown>, body = "# Duty\nbody"): void {
  const dir = path.join(tmp, ".kody", "duties", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: slug, ...profile }, null, 2))
  fs.writeFileSync(path.join(dir, "duty.md"), body)
}

function writeStaff(slug: string, body = "# Agent\nidentity"): void {
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
    writeStaff("kody")
    writeDuty("changelog-verify", { agent: "kody", mentions: ["a", "b"] })

    const ctx = ctxFor("changelog-verify")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.mentions).toBe("@a @b")
  })

  it("sets ctx.data.mentions to '' when the duty declares no mentions", async () => {
    writeStaff("kody")
    writeDuty("broad-sweep", { agent: "kody" })

    const ctx = ctxFor("broad-sweep")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.mentions).toBe("")
  })
})

describe("loadJobFromFile locked-toolbox (tools:)", () => {
  function lockedProfile(): Profile {
    return { claudeCode: { tools: [] as string[] } } as unknown as Profile
  }

  it("revokes Bash/Read and locks allowedTools to the declared kody-duty tools + submit_state", async () => {
    writeStaff("cto")
    writeDuty("dev-ci-health", {
      agent: "cto",
      tools: ["read_check_runs", "ensure_issue", "dispatch_workflow", "ensure_comment"],
    })

    const ctx = ctxFor("dev-ci-health")
    const profile = lockedProfile()
    await loadJobFromFile(ctx, profile, {})

    expect(ctx.data.dutyTools).toEqual(["read_check_runs", "ensure_issue", "dispatch_workflow", "ensure_comment"])
    const lockedTools = (profile as unknown as { claudeCode: { tools: string[] } }).claudeCode.tools
    expect(lockedTools).toEqual([
      "mcp__kody-duty__read_check_runs",
      "mcp__kody-duty__ensure_issue",
      "mcp__kody-duty__dispatch_workflow",
      "mcp__kody-duty__ensure_comment",
      "mcp__kody-submit__submit_state",
    ])
    // The raw escape hatches are gone.
    expect(lockedTools).not.toContain("Bash")
    expect(lockedTools).not.toContain("Read")
    expect(ctx.data.promptTemplate).toBe("prompts/locked.md")
  })

  it("throws if a duty declares a tool not in the kody-duty palette", async () => {
    writeStaff("cto")
    writeDuty("bad", { agent: "cto", tools: ["read_check_runs", "make_coffee"] })

    await expect(loadJobFromFile(ctxFor("bad"), lockedProfile(), {})).rejects.toThrow(/make_coffee/)
  })
})

describe("loadJobFromFile body {{mentions}} substitution", () => {
  it("replaces {{mentions}} inside the duty body with the resolved handles", async () => {
    writeStaff("kody")
    writeDuty("docs-readme", { agent: "kody", mentions: ["a", "b"] }, "# Duty\n{{mentions}} please review")

    const ctx = ctxFor("docs-readme")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.jobIntent).toContain("@a @b please review")
    expect(ctx.data.jobIntent).not.toContain("{{mentions}}")
  })

  it("tolerates inner whitespace and renders empty when no mentions are declared", async () => {
    writeStaff("kody")
    writeDuty("docs-code", { agent: "kody" }, "line {{ mentions }} end")

    const ctx = ctxFor("docs-code")
    await loadJobFromFile(ctx, PROFILE, {})

    expect(ctx.data.jobIntent).toBe("line  end")
    expect(ctx.data.jobIntent).not.toContain("mentions")
  })
})

describe("loadJobFromFile duty-noun aliases (Phase 1 rename)", () => {
  it("populates dutySlug/dutyTitle from the duty folder, mirroring jobSlug/jobTitle", async () => {
    writeStaff("kody")
    writeDuty("stale-prs", { agent: "kody" }, "# Stale PR Watcher\nbody text")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "duty-tick" }, {})

    expect(ctx.data.dutySlug).toBe("stale-prs")
    expect(ctx.data.dutyTitle).toBe("Stale PR Watcher")
    // Backwards compat: legacy fields still populated for the kody-job-next-state
    // fence label and existing prompt templates.
    expect(ctx.data.jobSlug).toBe("stale-prs")
    expect(ctx.data.jobTitle).toBe("Stale PR Watcher")
  })

  it("populates agentSlug/agentTitle from the agent file, mirroring agentSlug/agentTitle", async () => {
    writeStaff("kody", "# Kody — root agent")
    writeDuty("stale-prs", { agent: "kody" }, "# Stale PR Watcher")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "duty-tick" }, {})

    expect(ctx.data.agentSlug).toBe("kody")
    expect(ctx.data.agentTitle).toBe("Kody — root agent")
    // Legacy fields still populated.
    expect(ctx.data.agentSlug).toBe("kody")
    expect(ctx.data.agentTitle).toBe("Kody — root agent")
  })

  it("populates executableSlug from profile.name", async () => {
    writeStaff("kody")
    writeDuty("stale-prs", { agent: "kody" }, "# Stale PR Watcher")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "duty-tick" }, {})

    expect(ctx.data.executableSlug).toBe("duty-tick")
  })

  it("populates dutySchedule from the duty profile", async () => {
    writeStaff("kody")
    writeDuty("stale-prs", { agent: "kody", every: "1h" }, "# Stale PR Watcher")

    const ctx = ctxFor("stale-prs")
    await loadJobFromFile(ctx, { ...PROFILE, name: "duty-tick" }, {})

    expect(ctx.data.dutySchedule).toBe("1h")
  })

  it("leaves agentSlug empty when the duty has no agent declared", async () => {
    writeDuty("orphan", {}, "# Orphan Duty\nno agent")

    const ctx = ctxFor("orphan")
    await loadJobFromFile(ctx, { ...PROFILE, name: "duty-tick" }, {})

    expect(ctx.data.agentSlug).toBe("")
    expect(ctx.data.agentTitle).toBe("")
    expect(ctx.data.agentSlug).toBe("")
    expect(ctx.data.agentTitle).toBe("")
  })
})
