import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildTaskContext,
  persistTaskContext,
  readTaskContext,
  TASK_CONTEXT_SCHEMA_VERSION,
} from "../../src/taskContext.js"

describe("taskContext: buildTaskContext", () => {
  it("stamps the schema version and a builtAt timestamp", () => {
    const ctx = buildTaskContext({ runId: "r1" })
    expect(ctx.schemaVersion).toBe(TASK_CONTEXT_SCHEMA_VERSION)
    expect(ctx.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(ctx.runId).toBe("r1")
  })

  it("defaults missing fields to safe empty values", () => {
    const ctx = buildTaskContext({ runId: "r1" })
    expect(ctx.issue).toBeUndefined()
    expect(ctx.conventions).toEqual([])
    expect(ctx.priorArt).toBe("")
    expect(ctx.memoryContext).toBe("")
    expect(ctx.coverageRules).toEqual([])
  })

  it("preserves provided fields verbatim", () => {
    const ctx = buildTaskContext({
      runId: "r1",
      conventions: [{ path: "CLAUDE.md", content: "hello", truncated: false }],
      priorArt: "## prior\n- something",
      memoryContext: "memo",
      coverageRules: [{ pattern: "src/foo.ts", requireSibling: "tests/foo.test.ts" }],
    })
    expect(ctx.conventions[0]?.path).toBe("CLAUDE.md")
    expect(ctx.priorArt).toContain("prior")
    expect(ctx.memoryContext).toBe("memo")
    expect(ctx.coverageRules[0]?.pattern).toBe("src/foo.ts")
  })
})

describe("taskContext: persist + read round-trip", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-task-context-"))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("writes JSON to .kody/runs/<runId>/task-context.json and reads it back", () => {
    const ctx = buildTaskContext({
      runId: "rid-123",
      priorArt: "prior",
      memoryContext: "memo",
    })
    const file = persistTaskContext(tmpDir, ctx)
    expect(file).not.toBeNull()
    expect(file).toContain(".kody/runs/rid-123/task-context.json")
    expect(fs.existsSync(file!)).toBe(true)

    const reloaded = readTaskContext(tmpDir, "rid-123")
    expect(reloaded).not.toBeNull()
    expect(reloaded?.runId).toBe("rid-123")
    expect(reloaded?.priorArt).toBe("prior")
    expect(reloaded?.memoryContext).toBe("memo")
  })

  it("returns null for missing run id", () => {
    expect(readTaskContext(tmpDir, "no-such-run")).toBeNull()
  })

  it("returns null when the persisted file has a stale schema version", () => {
    const dir = path.join(tmpDir, ".kody", "runs", "stale-run")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, "task-context.json"),
      JSON.stringify({
        schemaVersion: 999,
        builtAt: "2026-05-11T00:00:00.000Z",
        runId: "stale-run",
        conventions: [],
        priorArt: "",
        memoryContext: "",
        coverageRules: [],
      }),
    )
    expect(readTaskContext(tmpDir, "stale-run")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    const dir = path.join(tmpDir, ".kody", "runs", "bad-run")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "task-context.json"), "{ not json")
    expect(readTaskContext(tmpDir, "bad-run")).toBeNull()
  })

  it("persistTaskContext does not throw on unwritable cwd", () => {
    // Point cwd at a path whose parent is a regular FILE → recursive mkdir
    // fails fast with ENOTDIR on every OS. (Do NOT use /proc/...: on Linux CI
    // Node's recursive mkdir spins forever stat-ing procfs, which hung the
    // entire test suite — caught via a gdb backtrace showing MKDirpSync on /proc.)
    const ctx = buildTaskContext({ runId: "x" })
    const fileAsParent = path.join(tmpDir, "not-a-dir")
    fs.writeFileSync(fileAsParent, "x")
    const result = persistTaskContext(path.join(fileAsParent, "no", "such", "path"), ctx)
    expect(result).toBeNull()
  })
})

describe("taskContext: issue field shape", () => {
  it("captures pre-formatted issue strings when provided", () => {
    const ctx = buildTaskContext({
      runId: "r",
      issue: {
        number: 42,
        title: "Test",
        body: "body",
        comments: [],
        labels: ["bug"],
        commentsFormatted: "(no comments)",
        labelsFormatted: "`bug`",
      },
    })
    expect(ctx.issue?.number).toBe(42)
    expect(ctx.issue?.commentsFormatted).toBe("(no comments)")
    expect(ctx.issue?.labelsFormatted).toBe("`bug`")
  })
})
