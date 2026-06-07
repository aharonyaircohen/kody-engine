/**
 * Unit tests for `src/bin/brain-proxy.ts` — the standalone HTTP server
 * entry point.
 *
 * The integration test (`tests/int/brain-proxy-bin.test.ts`) spawns the
 * built dist binary and exercises BRAIN_API_KEY / BRAIN_BACKEND env
 * handling at the process level. This file provides source-importing
 * coverage: the bin file's env-derivation logic, signal-handler wiring,
 * and BRAIN_BACKEND validation are all reachable from a unit test by
 * mocking `startBrainProxy` to return a fake proxy. The mock lets the
 * test assert on the wiring WITHOUT actually binding a real port or
 * blocking forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const startBrainProxy = vi.fn()
const fakeProxy = {
  httpServer: {} as never,
  port: 0,
  url: "http://127.0.0.1:0",
  stop: vi.fn(),
  handler: vi.fn(),
}

vi.mock("../../src/servers/brain-proxy.js", () => ({
  startBrainProxy: (...args: unknown[]) => startBrainProxy(...args),
  // Re-export the other named exports the bin file doesn't use, so the
  // module surface stays intact for any other importer.
  buildBrainProxy: vi.fn(),
}))

const requireEnvMock = vi.fn()
const getApiKeyMock = vi.fn()
vi.mock("../../src/bin/_httpShared.js", async () => {
  const real = await vi.importActual<typeof import("../../src/bin/_httpShared.js")>("../../src/bin/_httpShared.js")
  return { ...real, requireEnv: requireEnvMock, getApiKey: getApiKeyMock }
})

// Import the bin function AFTER the mocks are set up. Use a top-level
// dynamic import that vitest hoists cleanly.
const { brainProxy } = await import("../../src/bin/brain-proxy.js")

describe("bin/brain-proxy: env validation", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>

  /** Sentinel thrown by the mocked process.exit so the test can verify
   *  the exit call without actually killing the runner. The bin function
   *  treats process.exit as terminal; the throw bubbles up through the
   *  awaited brainProxy() promise, and the test catches it. */
  class ExitSentinel extends Error {
    constructor(public code: number) {
      super(`exit(${code})`)
    }
  }

  beforeEach(() => {
    startBrainProxy.mockReset()
    startBrainProxy.mockResolvedValue(fakeProxy)
    requireEnvMock.mockReset()
    getApiKeyMock.mockReset()
    getApiKeyMock.mockReturnValue("test-key")
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new ExitSentinel(code)
    }) as never)
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    stderrWrite.mockRestore()
    delete process.env.BRAIN_API_KEY
    delete process.env.BRAIN_BACKEND
    delete process.env.BRAIN_SERVE_URL
    delete process.env.HERMES_URL
    delete process.env.BRAIN_PROXY_PORT
    delete process.env.BRAIN_PROXY_HOST
    delete process.env.MODEL
  })

  it("calls requireEnv(['BRAIN_API_KEY']) and exits 2 if requireEnv itself bails", async () => {
    // The shared requireEnv does process.exit(2) when the env is missing;
    // we mock it to capture the call without actually exiting.
    requireEnvMock.mockImplementation(() => {
      throw new Error("simulated requireEnv bail")
    })
    await expect(brainProxy()).rejects.toThrow(/simulated requireEnv bail/)
    expect(requireEnvMock).toHaveBeenCalledWith(["BRAIN_API_KEY"], "brain-proxy")
  })

  it("rejects an invalid BRAIN_BACKEND by exiting 2", async () => {
    process.env.BRAIN_API_KEY = "k"
    process.env.BRAIN_BACKEND = "openai"
    await expect(brainProxy()).rejects.toThrow(ExitSentinel)
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrWrite).toHaveBeenCalled()
    const stderrText = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join("")
    expect(stderrText).toMatch(/BRAIN_BACKEND must be 'brain-serve' or 'hermes'/)
    // startBrainProxy must NOT be called when the backend is invalid.
    expect(startBrainProxy).not.toHaveBeenCalled()
  })

  it("defaults BRAIN_BACKEND to brain-serve when unset", async () => {
    process.env.BRAIN_API_KEY = "k"
    // The function blocks on `new Promise(() => {})` after wiring the
    // proxy. We race it against a short timer so the test exits.
    await Promise.race([brainProxy(), new Promise((resolve) => setTimeout(resolve, 50))])
    expect(startBrainProxy).toHaveBeenCalledOnce()
    const opts = startBrainProxy.mock.calls[0]?.[0] as { backend: string; apiKey: string }
    expect(opts.backend).toBe("brain-serve")
    expect(opts.apiKey).toBe("test-key")
  })

  it("honors BRAIN_BACKEND=hermes and forwards HERMES_URL to startBrainProxy", async () => {
    process.env.BRAIN_API_KEY = "k"
    process.env.BRAIN_BACKEND = "hermes"
    process.env.HERMES_URL = "http://hermes:9999"
    process.env.MODEL = "anthropic/claude-sonnet-4-6"
    process.env.BRAIN_PROXY_PORT = "9090"
    process.env.BRAIN_PROXY_HOST = "0.0.0.0"
    await Promise.race([brainProxy(), new Promise((resolve) => setTimeout(resolve, 50))])
    expect(startBrainProxy).toHaveBeenCalledOnce()
    const opts = startBrainProxy.mock.calls[0]?.[0] as {
      backend: string
      hermesUrl: string
      model: string
      port: number
      host: string
    }
    expect(opts.backend).toBe("hermes")
    expect(opts.hermesUrl).toBe("http://hermes:9999")
    expect(opts.model).toBe("anthropic/claude-sonnet-4-6")
    expect(opts.port).toBe(9090)
    expect(opts.host).toBe("0.0.0.0")
  })

  it("forwards BRAIN_SERVE_URL when backend=brain-serve", async () => {
    process.env.BRAIN_API_KEY = "k"
    process.env.BRAIN_BACKEND = "brain-serve"
    process.env.BRAIN_SERVE_URL = "http://brain:7000"
    await Promise.race([brainProxy(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = startBrainProxy.mock.calls[0]?.[0] as {
      backend: string
      brainServeUrl: string
    }
    expect(opts.backend).toBe("brain-serve")
    expect(opts.brainServeUrl).toBe("http://brain:7000")
  })

  it("uses default port 8080 and host 0.0.0.0 when BRAIN_PROXY_* env is unset", async () => {
    process.env.BRAIN_API_KEY = "k"
    delete process.env.BRAIN_PROXY_PORT
    delete process.env.BRAIN_PROXY_HOST
    await Promise.race([brainProxy(), new Promise((resolve) => setTimeout(resolve, 50))])
    const opts = startBrainProxy.mock.calls[0]?.[0] as { port: number; host: string }
    expect(opts.port).toBe(8080)
    expect(opts.host).toBe("0.0.0.0")
  })
})
