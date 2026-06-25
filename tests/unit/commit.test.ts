import { describe, expect, it } from "vitest"
import { FORBIDDEN_PATH_PREFIXES, isForbiddenPath, normalizeCommitMessage } from "../../src/commit.js"

describe("commit: isForbiddenPath", () => {
  it("blocks .kody/ artifacts", () => {
    expect(isForbiddenPath(".kody/last-run.jsonl")).toBe(true)
    expect(isForbiddenPath(".kody-engine/event-log.json")).toBe(true)
    expect(isForbiddenPath(".kody-lean/last-run.jsonl")).toBe(true)
  })

  it("blocks node_modules and build outputs", () => {
    expect(isForbiddenPath("node_modules/foo/index.js")).toBe(true)
    expect(isForbiddenPath("dist/cli.js")).toBe(true)
    expect(isForbiddenPath("build/x")).toBe(true)
  })

  it("blocks codegraph runtime scratch (never commit the repo-map tool's litter)", () => {
    expect(isForbiddenPath(".codegraph/daemon.pid")).toBe(true)
    expect(isForbiddenPath(".codegraph/.gitignore")).toBe(true)
    expect(isForbiddenPath(".codegraph/cache/graph.db")).toBe(true)
  })

  it("blocks .env exact and .log suffix", () => {
    expect(isForbiddenPath(".env")).toBe(true)
    expect(isForbiddenPath("debug.log")).toBe(true)
    expect(isForbiddenPath("logs/x.log")).toBe(true)
  })

  it("blocks kody.config.json (engine trust anchor)", () => {
    // The agent must never rewrite the config that declares the model, allowed
    // associations, and publishCommand (run via `bash -c` on release).
    expect(isForbiddenPath("kody.config.json")).toBe(true)
  })

  it("allows source files", () => {
    expect(isForbiddenPath("src/foo.ts")).toBe(false)
    expect(isForbiddenPath("README.md")).toBe(false)
    expect(isForbiddenPath("package.json")).toBe(false)
  })

  it("does not block .env.example", () => {
    expect(isForbiddenPath(".env.example")).toBe(false)
  })

  it("blocks memory and task artifacts because durable Kody state lives in the state repo", () => {
    expect(isForbiddenPath(".kody/memory/architecture/executor.md")).toBe(true)
    expect(isForbiddenPath(".kody/tasks/1/context.json")).toBe(true)
    expect(isForbiddenPath(".kody/tmp/tasks/1/context.json")).toBe(true)
  })
})

describe("commit: FORBIDDEN_PATH_PREFIXES shape", () => {
  it("has no duplicate entries (a duplicated prefix hides intent and risks drift on edit)", () => {
    // Catches the recurring bug where a path prefix gets added to the list
    // without removing an existing one (e.g. .kody/ listed at index 0 and
    // again at index 2 from a half-applied refactor).
    const seen = new Set<string>()
    const dups: string[] = []
    for (const p of FORBIDDEN_PATH_PREFIXES) {
      if (seen.has(p)) dups.push(p)
      seen.add(p)
    }
    expect(dups).toEqual([])
  })
})

describe("commit: normalizeCommitMessage", () => {
  it("preserves messages with valid conventional prefix", () => {
    expect(normalizeCommitMessage("feat: add X")).toBe("feat: add X")
    expect(normalizeCommitMessage("fix: handle Y")).toBe("fix: handle Y")
    expect(normalizeCommitMessage("chore: bump deps")).toBe("chore: bump deps")
  })

  it("prepends chore: when prefix missing", () => {
    expect(normalizeCommitMessage("update readme")).toBe("chore: update readme")
  })

  it("strips surrounding quotes", () => {
    expect(normalizeCommitMessage('"feat: x"')).toBe("feat: x")
    expect(normalizeCommitMessage("'fix: y'")).toBe("fix: y")
  })

  it("handles empty input", () => {
    expect(normalizeCommitMessage("")).toBe("chore: kody update")
    expect(normalizeCommitMessage("   ")).toBe("chore: kody update")
  })

  it("recognizes prefix case-insensitively", () => {
    expect(normalizeCommitMessage("Feat: add X")).toBe("Feat: add X")
  })

  it("checks only first line for prefix", () => {
    const msg = "feat: add X\n\nLong body\nfix: not a prefix here"
    expect(normalizeCommitMessage(msg)).toBe(msg)
  })
})
