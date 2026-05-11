import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { __resetRunIdCache } from "../../src/events.js"
import type { Profile, Context } from "../../src/executables/types.js"
import { loadTaskContext } from "../../src/scripts/loadTaskContext.js"
import { TASK_CONTEXT_SCHEMA_VERSION } from "../../src/taskContext.js"

const fakeProfile = { name: "test" } as unknown as Profile

function makeCtx(overrides: Partial<Context["data"]> = {}, cwd: string): Context {
  return {
    args: {},
    cwd,
    config: {
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "x", repo: "y" },
      agent: { model: "claude/claude-sonnet-4-6" },
    },
    data: { ...overrides },
    output: { exitCode: 0 },
  }
}

describe("loadTaskContext: assembly", () => {
  let tmpDir: string
  beforeEach(() => {
    __resetRunIdCache()
    process.env.KODY_RUN_ID = "test-run"
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-load-ctx-"))
  })
  afterEach(() => {
    delete process.env.KODY_RUN_ID
    __resetRunIdCache()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("assembles taskContext from ctx.data and persists to .kody/runs/<runId>/", async () => {
    const ctx = makeCtx(
      {
        issue: {
          number: 7,
          title: "T",
          body: "B",
          comments: [],
          labels: ["bug"],
          commentsFormatted: "(none)",
          labelsFormatted: "`bug`",
        },
        conventions: [{ path: "CLAUDE.md", content: "x", truncated: false }],
        priorArt: "prior",
        memoryContext: "memo",
        coverageRules: [],
      },
      tmpDir,
    )
    await loadTaskContext(ctx, fakeProfile)
    expect(ctx.data.taskContext).toBeDefined()
    const persisted = path.join(tmpDir, ".kody", "runs", "test-run", "task-context.json")
    expect(fs.existsSync(persisted)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(persisted, "utf-8"))
    expect(parsed.schemaVersion).toBe(TASK_CONTEXT_SCHEMA_VERSION)
    expect(parsed.runId).toBe("test-run")
    expect(parsed.issue?.number).toBe(7)
    expect(parsed.conventions[0]?.path).toBe("CLAUDE.md")
    expect(parsed.priorArt).toBe("prior")
  })

  it("tolerates a fully empty ctx.data — produces a minimal taskContext", async () => {
    const ctx = makeCtx({}, tmpDir)
    await loadTaskContext(ctx, fakeProfile)
    const tc = ctx.data.taskContext as { issue?: unknown; priorArt: string; memoryContext: string }
    expect(tc.issue).toBeUndefined()
    expect(tc.priorArt).toBe("")
    expect(tc.memoryContext).toBe("")
  })

  it("ignores wrong-type fields gracefully (priorArt as number → empty string)", async () => {
    const ctx = makeCtx({ priorArt: 12345 as unknown as string }, tmpDir)
    await loadTaskContext(ctx, fakeProfile)
    expect((ctx.data.taskContext as { priorArt: string }).priorArt).toBe("")
  })

  it("populates issue without optional formatted fields when loaders omitted them", async () => {
    const ctx = makeCtx(
      {
        issue: { number: 1, title: "T", body: "B", comments: [], labels: [] },
      },
      tmpDir,
    )
    await loadTaskContext(ctx, fakeProfile)
    const tc = ctx.data.taskContext as { issue: { commentsFormatted: string; labelsFormatted: string } }
    expect(tc.issue.commentsFormatted).toBe("")
    expect(tc.issue.labelsFormatted).toBe("")
  })
})
