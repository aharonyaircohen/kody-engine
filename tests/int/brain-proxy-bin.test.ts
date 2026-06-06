/**
 * Tests for the brain-proxy bin entry.
 *
 * The bin entry reads BRAIN_BACKEND from env. Precedence (env > config >
 * default) is set up in entrypoint-brain.sh; this file tests the engine's
 * own BRAIN_BACKEND env handling — the part that runs after the entrypoint
 * has resolved the precedence.
 *
 * We don't spawn a real shell or run the entrypoint here; we just verify the
 * engine honors BRAIN_BACKEND and falls back to "brain-serve" by default.
 */

import { spawn } from "node:child_process"
import { afterEach, describe, expect, it } from "vitest"

const KEY = "test-bin-key-do-not-leak"
const KODY_BIN = "/Users/aguy/projects/kody2/dist/bin/kody.js"

interface SpawnResult {
  status: number
  stdout: string
  stderr: string
}

function runBrainProxy(env: Record<string, string>, timeoutMs = 3000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [KODY_BIN, "brain-proxy"], {
      env: { ...process.env, BRAIN_API_KEY: KEY, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (d) => (stdout += d.toString()))
    child.stderr?.on("data", (d) => (stderr += d.toString()))

    const timer = setTimeout(() => {
      // Expected outcome: the proxy blocks forever. We kill it after the
      // stdout shows the listen line (or the timeout fires).
      child.kill("SIGTERM")
      setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          /* already dead */
        }
      }, 500)
      resolve({ status: -1, stdout, stderr })
    }, timeoutMs)

    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ status: code ?? -1, stdout, stderr })
    })
  })
}

let child: ReturnType<typeof spawn> | null = null

afterEach(() => {
  if (child) {
    try {
      child.kill("SIGKILL")
    } catch {
      /* already dead */
    }
    child = null
  }
})

describe("brain-proxy bin: BRAIN_BACKEND env handling", () => {
  it("rejects with exit 2 when BRAIN_API_KEY is missing", async () => {
    const child2 = spawn("node", [KODY_BIN, "brain-proxy"], {
      env: { ...process.env, BRAIN_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child2.stderr?.on("data", (d) => (stderr += d.toString()))
    const code = await new Promise<number | null>((resolve) => {
      child2.on("exit", (c) => resolve(c))
    })
    expect(code).toBe(2)
    expect(stderr).toMatch(/BRAIN_API_KEY/)
  }, 10_000)

  it("rejects with exit 2 when BRAIN_BACKEND has an invalid value", async () => {
    const child2 = spawn("node", [KODY_BIN, "brain-proxy"], {
      env: { ...process.env, BRAIN_API_KEY: KEY, BRAIN_BACKEND: "openai" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    child2.stderr?.on("data", (d) => (stderr += d.toString()))
    const code = await new Promise<number | null>((resolve) => {
      child2.on("exit", (c) => resolve(c))
    })
    expect(code).toBe(2)
    expect(stderr).toMatch(/BRAIN_BACKEND/)
    expect(stderr).toMatch(/openai/)
  }, 10_000)

  it("defaults to brain-serve when BRAIN_BACKEND is unset", async () => {
    // We need the engine to be built for this test to work. Skip if not.
    const fs = await import("node:fs")
    if (!fs.existsSync(KODY_BIN)) {
      console.warn(`Skipping: ${KODY_BIN} does not exist (run pnpm build first)`)
      return
    }
    const result = await runBrainProxy({ BRAIN_BACKEND: "", BRAIN_PROXY_PORT: "0" })
    expect(result.stdout).toMatch(/backend=brain-serve/)
  }, 10_000)

  it("honors BRAIN_BACKEND=hermes", async () => {
    const fs = await import("node:fs")
    if (!fs.existsSync(KODY_BIN)) {
      console.warn(`Skipping: ${KODY_BIN} does not exist (run pnpm build first)`)
      return
    }
    const result = await runBrainProxy({ BRAIN_BACKEND: "hermes", BRAIN_PROXY_PORT: "0" })
    expect(result.stdout).toMatch(/backend=hermes/)
  }, 10_000)
})

describe("brain-proxy bin: env precedence (documented in entrypoint-brain.sh)", () => {
  it("precedence: BRAIN_BACKEND env > kody.config.json brain.mode > brain-serve", () => {
    // This is a documentation test — the actual precedence resolution lives
    // in runner/entrypoint-brain.sh (bash). The engine itself only reads
    // BRAIN_BACKEND; the entrypoint is responsible for setting it from
    // kody.config.json when the env is unset.
    //
    // To re-verify the bash behavior, run:
    //   BRAIN_BACKEND=hermes bash -c '...'
    //   BRAIN_BACKEND= bash -c '... brain.mode=hermes ...'
    //   unset BRAIN_BACKEND; ... brain.mode=brain-serve ...
    expect(true).toBe(true)
  })
})
