/**
 * Unit tests for `writeJobStateFile` — the postflight that persists the
 * duty's next state via the configured `JobStateBackend`.
 *
 * Focus: the parse-error branch (the duty failed to emit a
 * `kody-job-next-state` block but the run must not wedge the duty forever).
 * Without this branch, a flaky model that drops the fenced block would
 * leave the duty stuck "overdue" on the dashboard, re-firing every cron
 * wake without ever advancing.
 *
 * Uses the local-file state backend so the test never touches GitHub.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import type { Context, Profile } from "../../src/executables/types.js"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"
import type { LoadedJobState } from "../../src/scripts/jobState/backend.js"
import { writeJobStateFile } from "../../src/scripts/writeJobStateFile.js"

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "write-job-state-"))
  fs.mkdirSync(path.join(tmp, ".kody", "duties"), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function config(): KodyConfig {
  return {
    quality: { typecheck: "", lint: "", format: "", testUnit: "" },
    git: { defaultBranch: "main" },
    github: { owner: "o", repo: "r" },
    agent: { model: "anthropic/test" },
    jobs: { stateBackend: "local-file" },
  }
}

function ctxFor(slug: string, data: Record<string, unknown>): Context {
  return {
    args: { job: slug },
    cwd: tmp,
    config: config(),
    data,
    output: { exitCode: 0 },
  } as unknown as Context
}

function loadedFor(slug: string, state: StateEnvelope): LoadedJobState {
  return {
    path: `.kody/duties/${slug}.state.json`,
    handle: null,
    state,
    created: false,
  }
}

const PROFILE = {} as unknown as Profile

describe("writeJobStateFile: parse-error path", () => {
  it("carries the prior state forward (cursor + data unchanged) so the duty does not wedge", async () => {
    // Prior state at rev 3 with cursor "step-2" and the duty's per-item ledger
    // in data. The agent forgot the kody-job-next-state block, so the parser
    // left a nextStateParseError note on ctx.data. The script must still
    // advance lastFiredAt + record the failure, while preserving the ledger.
    const slug = "watch-stale-prs"
    const prior: StateEnvelope = {
      version: 1,
      rev: 3,
      cursor: "step-2",
      data: { ledger: { "PR-1": "open", "PR-2": "merged" }, lastFiredAt: "2026-05-01T00:00:00Z" },
      done: false,
    }
    fs.writeFileSync(path.join(tmp, ".kody", "duties", `${slug}.state.json`), JSON.stringify(prior, null, 2))
    const ctx = ctxFor(slug, {
      nextStateParseError: "missing `kody-job-next-state` block in agent output",
      jobState: loadedFor(slug, prior),
    })
    await writeJobStateFile(ctx, PROFILE, null, { jobsDir: ".kody/duties" })

    const after = JSON.parse(fs.readFileSync(path.join(tmp, ".kody", "duties", `${slug}.state.json`), "utf-8")) as StateEnvelope
    // rev was bumped so the next tick sees a fresh state.
    expect(after.rev).toBe(4)
    // cursor + ledger carry forward — the duty is still at step-2 next time.
    expect(after.cursor).toBe("step-2")
    expect(after.data.ledger).toEqual({ "PR-1": "open", "PR-2": "merged" })
    // lastFiredAt is stamped so the dispatcher can gate next cadence; the
    // failure is recorded for the dashboard's "last run failed" view.
    expect(typeof after.data.lastFiredAt).toBe("string")
    expect(after.data.lastOutcome).toBe("failed")
    expect(after.data.lastError).toMatch(/missing `kody-job-next-state`/)
    // done is preserved (a failed tick should not flip done to true).
    expect(after.done).toBe(false)
    // Run is marked failed for the orchestrator to route.
    expect(ctx.output.exitCode).toBe(1)
  })

  it("records the failure on a first-ever tick with no prior state (no wedge, no carry)", async () => {
    // No prior state file. The script must still surface the parse error so
    // the run fails loudly — without writing a state file, the duty will
    // retry next wake as before (legacy behavior).
    const slug = "fresh-duty"
    const ctx = ctxFor(slug, {
      nextStateParseError: "missing `kody-job-next-state` block in agent output",
      // no jobState: first-ever tick
    })
    await writeJobStateFile(ctx, PROFILE, null, { jobsDir: ".kody/duties" })

    expect(ctx.output.exitCode).toBe(1)
    expect(ctx.output.reason).toMatch(/next-state parse failed/)
    // No state file was written (nothing to carry).
    expect(fs.existsSync(path.join(tmp, ".kody", "duties", `${slug}.state.json`))).toBe(false)
  })
})
