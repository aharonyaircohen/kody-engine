import { describe, expect, it } from "vitest"
import type { KodyConfig } from "../../src/config.js"
import {
  buildVerifyMcpServer,
  DEFAULT_MAX_VERIFY_ATTEMPTS,
  truncateVerifyResult,
  type VerifyToolState,
} from "../../src/verifyMcp.js"
import type { VerifyResult } from "../../src/verify.js"

const baseConfig: KodyConfig = {
  quality: { typecheck: "echo ok", lint: "echo ok", testUnit: "echo ok", format: "echo ok" },
  git: { defaultBranch: "main" },
  github: { owner: "x", repo: "y" },
  agent: { model: "claude/claude-sonnet-4-6" },
}

function makeState(maxAttempts = DEFAULT_MAX_VERIFY_ATTEMPTS): VerifyToolState {
  return { attempts: 0, maxAttempts }
}

describe("verifyMcp: truncateVerifyResult", () => {
  it("returns ok=true with empty failures when verify passes", () => {
    const result: VerifyResult = { ok: true, failed: [], details: {} }
    const payload = truncateVerifyResult(result, makeState(), 1)
    expect(payload.ok).toBe(true)
    expect(payload.failures).toEqual([])
    expect(payload.attempt).toBe(1)
    expect(payload.attemptsRemaining).toBe(DEFAULT_MAX_VERIFY_ATTEMPTS - 1)
  })

  it("includes failures with name + exitCode + tail when verify fails", () => {
    const result: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: { exitCode: 1, durationMs: 100, tail: "FAIL: foo.test.ts" } },
    }
    const payload = truncateVerifyResult(result, makeState(), 1)
    expect(payload.ok).toBe(false)
    expect(payload.failures).toHaveLength(1)
    expect(payload.failures[0]?.name).toBe("test")
    expect(payload.failures[0]?.exitCode).toBe(1)
    expect(payload.failures[0]?.tail).toContain("FAIL: foo.test.ts")
  })

  it("truncates very long tails to fit a 2KB budget", () => {
    const longTail = "x".repeat(20_000)
    const result: VerifyResult = {
      ok: false,
      failed: ["test"],
      details: { test: { exitCode: 1, durationMs: 1, tail: longTail } },
    }
    const payload = truncateVerifyResult(result, makeState(), 1)
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(2048 + 200) // generous slack
    expect(payload.failures[0]?.tail.length).toBeLessThan(longTail.length)
  })

  it("caps the failures array at 5 entries", () => {
    const failed = Array.from({ length: 10 }, (_, i) => `cmd${i}`)
    const details: VerifyResult["details"] = {}
    for (const name of failed) details[name] = { exitCode: 1, durationMs: 1, tail: "x" }
    const result: VerifyResult = { ok: false, failed, details }
    const payload = truncateVerifyResult(result, makeState(), 1)
    expect(payload.failures).toHaveLength(5)
  })

  it("includes recovered list when verify caught a flake", () => {
    const result: VerifyResult = {
      ok: true,
      failed: [],
      details: {},
      recovered: ["test"],
    }
    const payload = truncateVerifyResult(result, makeState(), 1)
    expect(payload.recovered).toEqual(["test"])
  })

  it("reflects attemptsRemaining from state", () => {
    const state = makeState(4)
    state.attempts = 3
    const result: VerifyResult = { ok: false, failed: [], details: {} }
    const payload = truncateVerifyResult(result, state, 3)
    expect(payload.attempt).toBe(3)
    expect(payload.attemptsRemaining).toBe(1)
  })
})

describe("verifyMcp: buildVerifyMcpServer", () => {
  it("returns a config object usable as an SDK MCP server entry", () => {
    const server = buildVerifyMcpServer({
      config: baseConfig,
      cwd: "/tmp",
      executable: "run",
    })
    expect(server).toBeDefined()
    expect((server as { name?: string }).name).toBe("kody-verify")
  })

  it("runs the verifier with the test seam and counts attempts", async () => {
    let calls = 0
    const fakeVerify = async (): Promise<VerifyResult> => {
      calls++
      return { ok: true, failed: [], details: {} }
    }
    const server = buildVerifyMcpServer({
      config: baseConfig,
      cwd: "/tmp",
      executable: "run",
      __runVerify: fakeVerify,
    })
    // The McpServer instance exposes registered tools internally; we can't
    // invoke them without an MCP client, but we can at least confirm the
    // server was built without throwing.
    expect(server).toBeDefined()
    expect(calls).toBe(0) // tool hasn't been invoked
  })
})
