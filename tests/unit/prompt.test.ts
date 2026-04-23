import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import { buildPrompt, loadProjectConventions, parseAgentResult } from "../../src/prompt.js"

const baseConfig: KodyConfig = {
  quality: { typecheck: "pnpm tc", testUnit: "pnpm test", lint: "" },
  git: { defaultBranch: "main" },
  github: { owner: "o", repo: "r" },
  agent: { model: "minimax/m" },
}

describe("prompt: buildPrompt", () => {
  it("includes issue body, branch, and quality commands", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 42, title: "Add X", body: "BODY HERE", comments: [] },
      featureBranch: "42-add-x",
    })
    expect(p).toMatch(/Add X/)
    expect(p).toMatch(/BODY HERE/)
    expect(p).toMatch(/42-add-x/)
    expect(p).toMatch(/pnpm tc/)
    expect(p).toMatch(/pnpm test/)
  })

  it("omits empty quality commands", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).not.toMatch(/^- lint:/m)
  })

  it("includes lint when configured", () => {
    const cfg = { ...baseConfig, quality: { ...baseConfig.quality, lint: "pnpm lint" } }
    const p = buildPrompt({
      config: cfg,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/pnpm lint/)
  })

  it("respects per-repo commentLimit config (capped)", () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({
      body: `comment ${i}`,
      author: `user${i}`,
      createdAt: `2026-04-0${i + 1}`,
    }))
    const cfg = { ...baseConfig, issueContext: { commentLimit: 3 } }
    const p = buildPrompt({
      config: cfg,
      issue: { number: 1, title: "x", body: "", comments },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/comment 7/)
    expect(p).toMatch(/comment 5/)
    expect(p).not.toMatch(/comment 4/)
  })

  it("defaults commentLimit to 50 when not configured", () => {
    const comments = Array.from({ length: 8 }, (_, i) => ({
      body: `comment ${i}`,
      author: `user${i}`,
      createdAt: `2026-04-0${i + 1}`,
    }))
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/comment 0/)
    expect(p).toMatch(/comment 7/)
    const lastIdx = p.indexOf("comment 7")
    const firstIdx = p.indexOf("comment 3")
    expect(lastIdx).toBeLessThan(firstIdx)
  })

  it("respects per-repo commentMaxBytes config", () => {
    const huge = "x".repeat(5000)
    const cfg = { ...baseConfig, issueContext: { commentMaxBytes: 100 } }
    const p = buildPrompt({
      config: cfg,
      issue: { number: 1, title: "x", body: "", comments: [{ body: huge, author: "u", createdAt: "" }] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/truncated/)
    expect(p).not.toMatch(/x{200}/)
  })

  it("truncates comments larger than default maxBytes (10000)", () => {
    const huge = "x".repeat(15000)
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [{ body: huge, author: "u", createdAt: "" }] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/truncated/)
  })

  it("instructs not to run git/gh", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).toMatch(/Do NOT run \*\*any\*\* `git` or `gh` commands/)
  })
})

describe("prompt: loadProjectConventions", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "kody-conv-"))
  }

  it("returns empty array when no convention files exist", () => {
    const dir = tmpDir()
    expect(loadProjectConventions(dir)).toEqual([])
  })

  it("loads AGENTS.md when present", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\nUse pnpm")
    const result = loadProjectConventions(dir)
    expect(result).toHaveLength(1)
    expect(result[0]!.path).toBe("AGENTS.md")
    expect(result[0]!.content).toContain("Use pnpm")
    expect(result[0]!.truncated).toBe(false)
  })

  it("loads CLAUDE.md before AGENTS.md (Claude Code is canonical)", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "AGENTS")
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "CLAUDE")
    const result = loadProjectConventions(dir)
    expect(result.map((c) => c.path)).toEqual(["CLAUDE.md", "AGENTS.md"])
  })

  it("ignores non-convention files like .kody/steps/build.md", () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, ".kody/steps"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".kody/steps/build.md"), "STAGE TEMPLATE")
    expect(loadProjectConventions(dir)).toEqual([])
  })

  it("truncates very large files at the cap", () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "x".repeat(50_000))
    const result = loadProjectConventions(dir)
    expect(result[0]!.truncated).toBe(true)
    expect(result[0]!.content).toMatch(/truncated/)
    expect(result[0]!.content.length).toBeLessThan(50_000)
  })
})

describe("prompt: buildPrompt with conventions", () => {
  it("includes a Project conventions section when conventions are supplied", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
      conventions: [{ path: "AGENTS.md", content: "All tests in /tests/", truncated: false }],
    })
    expect(p).toMatch(/# Project conventions \(AUTHORITATIVE/)
    expect(p).toMatch(/## AGENTS\.md/)
    expect(p).toMatch(/All tests in \/tests\//)
  })

  it("omits the conventions section when none supplied", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "x", body: "", comments: [] },
      featureBranch: "1-x",
    })
    expect(p).not.toMatch(/# Project conventions/)
  })

  it("places conventions before the issue body for prominence", () => {
    const p = buildPrompt({
      config: baseConfig,
      issue: { number: 1, title: "Add X", body: "BODY", comments: [] },
      featureBranch: "1-x",
      conventions: [{ path: "AGENTS.md", content: "RULES", truncated: false }],
    })
    expect(p.indexOf("Project conventions")).toBeLessThan(p.indexOf("Issue #1"))
  })
})

describe("prompt: parseAgentResult", () => {
  it("parses DONE + COMMIT_MSG + PR_SUMMARY", () => {
    const result = parseAgentResult("DONE\nCOMMIT_MSG: feat: add X\nPR_SUMMARY:\n- Added X\n- Updated Y")
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("feat: add X")
    expect(result.prSummary).toBe("- Added X\n- Updated Y")
  })

  it("parses FAILED with reason", () => {
    const result = parseAgentResult("FAILED: tests broken")
    expect(result.done).toBe(false)
    expect(result.failureReason).toBe("tests broken")
  })

  it("returns failure when no marker present", () => {
    const result = parseAgentResult("just some text")
    expect(result.done).toBe(false)
    expect(result.failureReason).toMatch(/no DONE or FAILED/)
  })

  it("returns failure when text is empty", () => {
    const result = parseAgentResult("")
    expect(result.done).toBe(false)
    expect(result.failureReason).toMatch(/no final message/)
  })

  it("DONE without COMMIT_MSG returns empty commit msg", () => {
    const result = parseAgentResult("DONE")
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("")
  })

  it("DONE without PR_SUMMARY returns empty summary", () => {
    const result = parseAgentResult("DONE\nCOMMIT_MSG: feat: x")
    expect(result.done).toBe(true)
    expect(result.prSummary).toBe("")
  })

  it("ignores surrounding text around DONE marker", () => {
    const result = parseAgentResult("All set!\n\nDONE\nCOMMIT_MSG: chore: tidy\nPR_SUMMARY:\nMinor cleanup.")
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("chore: tidy")
    expect(result.prSummary).toBe("Minor cleanup.")
  })

  it("strips trailing code-fence markers from PR_SUMMARY", () => {
    const result = parseAgentResult("DONE\nCOMMIT_MSG: feat: x\nPR_SUMMARY:\n- Added foo\n```")
    expect(result.prSummary).toBe("- Added foo")
  })

  it("extracts FEEDBACK_ACTIONS block between marker and COMMIT_MSG", () => {
    const text = [
      "DONE",
      "FEEDBACK_ACTIONS:",
      '- Item 1: "cache per-request" — fixed: moved cache to module scope',
      '- Item 2: "case-insensitive match" — fixed: switched to $regex i',
      "COMMIT_MSG: fix: address review",
      "PR_SUMMARY:",
      "- Cache moved",
      "- Case insensitive added",
    ].join("\n")
    const result = parseAgentResult(text)
    expect(result.done).toBe(true)
    expect(result.feedbackActions).toContain("Item 1")
    expect(result.feedbackActions).toContain("Item 2")
    expect(result.feedbackActions).not.toContain("COMMIT_MSG")
    expect(result.prSummary).toBe("- Cache moved\n- Case insensitive added")
  })

  it("returns empty feedbackActions when block is absent", () => {
    const result = parseAgentResult("DONE\nCOMMIT_MSG: feat: x\nPR_SUMMARY:\n- y")
    expect(result.done).toBe(true)
    expect(result.feedbackActions).toBe("")
  })

  it("accepts COMMIT_MSG alone as a completion signal (missing DONE sentinel)", () => {
    // Weaker models sometimes finish the contract body (COMMIT_MSG +
    // PR_SUMMARY) but drop the bare DONE line. If the structured
    // artifact is there, treat the session as complete.
    const result = parseAgentResult("COMMIT_MSG: fix: y\nPR_SUMMARY:\n- fixed y")
    expect(result.done).toBe(true)
    expect(result.commitMessage).toBe("fix: y")
    expect(result.prSummary).toBe("- fixed y")
  })

  it("still fails when neither DONE nor COMMIT_MSG is present", () => {
    const result = parseAgentResult("All good, work complete, proceeding.")
    expect(result.done).toBe(false)
    expect(result.failureReason).toMatch(/no DONE or FAILED/)
  })
})
