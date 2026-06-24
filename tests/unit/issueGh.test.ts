import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(() => ""),
}))

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}))

import { gh } from "../../src/issue.js"

const TOKEN_ENV_KEYS = ["GITHUB_TOKEN", "KODY_TOKEN", "GH_TOKEN", "GH_PAT"] as const
type ExecFileSyncCall = [string, string[], { env?: NodeJS.ProcessEnv }]

afterEach(() => {
  mocks.execFileSync.mockClear()
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
})
