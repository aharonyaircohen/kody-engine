import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn((..._args: unknown[]) => ""),
}))

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}))

import { gh } from "../../src/issue.js"

const TOKEN_ENV_KEYS = [
  "GITHUB_TOKEN",
  "KODY_TOKEN",
  "GH_TOKEN",
  "GH_PAT",
  "KODY_GH_RATE_LIMIT_BASE_DELAY_MS",
  "KODY_GH_RATE_LIMIT_MAX_RETRIES",
  "KODY_GH_RATE_LIMIT_MAX_WAIT_MS",
] as const
type ExecFileSyncCall = [string, string[], { env?: NodeJS.ProcessEnv }]

afterEach(() => {
  vi.restoreAllMocks()
  mocks.execFileSync.mockReset()
  mocks.execFileSync.mockReturnValue("")
  for (const key of TOKEN_ENV_KEYS) delete process.env[key]
})

describe("gh token selection", () => {
  it("defaults to the state token when both state and repo tokens exist", () => {
    process.env.GITHUB_TOKEN = "repo-token"
    process.env.GH_PAT = "state-token"

    gh(["api", "repos/state/repo/contents/file"])

    const options = (mocks.execFileSync.mock.calls[0] as unknown as ExecFileSyncCall | undefined)?.[2]
    expect(options?.env?.GH_TOKEN).toBe("state-token")
  })

  it("uses the repo token when a repo read opts in", () => {
    process.env.GITHUB_TOKEN = "repo-token"
    process.env.GH_PAT = "state-token"

    gh(["api", "repos/current/repo/commits/dev/check-runs"], { preferRepoToken: true })

    const options = (mocks.execFileSync.mock.calls[0] as unknown as ExecFileSyncCall | undefined)?.[2]
    expect(options?.env?.GH_TOKEN).toBe("repo-token")
  })

  it("retries and logs GitHub rate-limit failures", () => {
    process.env.KODY_TOKEN = "state-token"
    process.env.KODY_GH_RATE_LIMIT_BASE_DELAY_MS = "0"
    process.env.KODY_GH_RATE_LIMIT_MAX_RETRIES = "1"
    process.env.KODY_GH_RATE_LIMIT_MAX_WAIT_MS = "0"
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    let mainCalls = 0
    mocks.execFileSync.mockImplementation((...args: unknown[]) => {
      const ghArgs = args[1] as string[]
      if (ghArgs[0] === "api" && ghArgs[1] === "rate_limit") return ""
      mainCalls += 1
      if (mainCalls === 1) {
        throw new Error("gh: API rate limit exceeded for installation ID 135742721 (HTTP 403)")
      }
      return "ok"
    })

    expect(gh(["api", "/repos/acme/widgets"])).toBe("ok")
    expect(mainCalls).toBe(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("[kody gh] rate limit"))
  })

  it("does not retry ordinary gh failures", () => {
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("gh: repository not found (HTTP 404)")
    })

    expect(() => gh(["api", "/repos/acme/missing"])).toThrow("repository not found")
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1)
  })

  it("fails fast when the GitHub reset wait is longer than the configured max", () => {
    process.env.KODY_TOKEN = "state-token"
    process.env.KODY_GH_RATE_LIMIT_MAX_RETRIES = "2"
    process.env.KODY_GH_RATE_LIMIT_MAX_WAIT_MS = "1"
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    let mainCalls = 0
    mocks.execFileSync.mockImplementation((...args: unknown[]) => {
      const ghArgs = args[1] as string[]
      if (ghArgs[0] === "api" && ghArgs[1] === "rate_limit") {
        return String(Math.ceil((Date.now() + 60_000) / 1_000))
      }
      mainCalls += 1
      throw new Error("gh: API rate limit exceeded for installation ID 135742721 (HTTP 403)")
    })

    expect(() => gh(["api", "/repos/acme/widgets"])).toThrow("rate limit exceeded")
    expect(mainCalls).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("exceeds max"))
  })
})
