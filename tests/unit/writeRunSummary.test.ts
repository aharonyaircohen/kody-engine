import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Context, Profile } from "../../src/executables/types.js"
import { writeRunSummary } from "../../src/scripts/writeRunSummary.js"

function baseCtx(overrides: Partial<Context> = {}): Context {
  return {
    args: { issue: 42 },
    cwd: process.cwd(),
    config: {} as Context["config"],
    data: {},
    output: { exitCode: 0 },
    ...overrides,
  }
}

function fakeProfile(name: string): Profile {
  return { name } as Profile
}

describe("writeRunSummary", () => {
  let summaryFile: string
  let prevEnv: string | undefined

  beforeEach(() => {
    summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kody-summary-")), "step-summary.md")
    prevEnv = process.env.GITHUB_STEP_SUMMARY
    process.env.GITHUB_STEP_SUMMARY = summaryFile
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.GITHUB_STEP_SUMMARY
    else process.env.GITHUB_STEP_SUMMARY = prevEnv
  })

  it("writes a success summary with PR url", async () => {
    const ctx = baseCtx({
      args: { issue: 42 },
      output: { exitCode: 0, prUrl: "https://github.com/x/y/pull/99" },
    })
    await writeRunSummary(ctx, fakeProfile("run"), null)
    const written = fs.readFileSync(summaryFile, "utf-8")
    expect(written).toMatch(/success/)
    expect(written).toMatch(/\*\*Executable:\*\* `run`/)
    expect(written).toMatch(/issue #42/)
    expect(written).toMatch(/pull\/99/)
    expect(written).toMatch(/Exit code:\*\* 0/)
  })

  it("labels exit 3 as no-op", async () => {
    const ctx = baseCtx({
      args: { pr: 7 },
      output: { exitCode: 3, reason: "clean merge, nothing to do" },
    })
    await writeRunSummary(ctx, fakeProfile("resolve"), null)
    const written = fs.readFileSync(summaryFile, "utf-8")
    expect(written).toMatch(/no-op/)
    expect(written).toMatch(/PR #7/)
    expect(written).toMatch(/clean merge/)
  })

  it("labels non-zero exit as failed", async () => {
    const ctx = baseCtx({ output: { exitCode: 2, reason: "verify failed" } })
    await writeRunSummary(ctx, fakeProfile("run"), null)
    const written = fs.readFileSync(summaryFile, "utf-8")
    expect(written).toMatch(/failed/)
    expect(written).toMatch(/verify failed/)
  })

  it("silently no-ops when GITHUB_STEP_SUMMARY is not set", async () => {
    delete process.env.GITHUB_STEP_SUMMARY
    const ctx = baseCtx()
    await expect(writeRunSummary(ctx, fakeProfile("run"), null)).resolves.toBeUndefined()
    expect(fs.existsSync(summaryFile)).toBe(false)
  })
})
