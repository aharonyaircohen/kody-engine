import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { gh as ghMock } from "../../src/issue.js"
import { clearStateRepoRuntimeCacheForTests, writeStateText } from "../../src/stateRepo.js"

const gh = vi.mocked(ghMock)

describe("stateRepo runtime cache", () => {
  beforeEach(() => {
    gh.mockReset()
    clearStateRepoRuntimeCacheForTests()
    gh.mockReturnValue("{}")
  })

  it("checks that the state branch exists only once per process/repo", () => {
    const config = { state: { repo: "acme/kody-state", path: "widgets" } }

    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "first")
    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "second")

    const branchChecks = gh.mock.calls.filter((call) =>
      ((call[0] as string[]) ?? []).includes("/repos/acme/kody-state/git/ref/heads/main"),
    )
    const puts = gh.mock.calls.filter((call) => ((call[0] as string[]) ?? []).includes("PUT"))

    expect(branchChecks).toHaveLength(1)
    expect(puts).toHaveLength(2)
  })

  it("keeps branch existence cache scoped per state repo", () => {
    writeStateText(
      { state: { repo: "acme/kody-state", path: "widgets" } },
      "/tmp/repo",
      "tasks/issues/1/state.json",
      "{}\n",
      "first",
    )
    writeStateText(
      { state: { repo: "beta/kody-state", path: "widgets" } },
      "/tmp/repo",
      "tasks/issues/1/state.json",
      "{}\n",
      "second",
    )

    const acmeChecks = gh.mock.calls.filter((call) =>
      ((call[0] as string[]) ?? []).includes("/repos/acme/kody-state/git/ref/heads/main"),
    )
    const betaChecks = gh.mock.calls.filter((call) =>
      ((call[0] as string[]) ?? []).includes("/repos/beta/kody-state/git/ref/heads/main"),
    )

    expect(acmeChecks).toHaveLength(1)
    expect(betaChecks).toHaveLength(1)
  })

  it("caches the branch after creating it", () => {
    const config = { state: { repo: "acme/kody-state", path: "widgets", branch: "kody-state" } }
    let branchChecks = 0

    gh.mockImplementation((args) => {
      const ghArgs = args as string[]
      if (ghArgs.includes("/repos/acme/kody-state/git/ref/heads/kody-state")) {
        branchChecks += 1
        throw new Error("Not Found (HTTP 404)")
      }
      if (ghArgs.includes("/repos/acme/kody-state")) return JSON.stringify({ default_branch: "main" })
      if (ghArgs.includes("/repos/acme/kody-state/git/ref/heads/main")) {
        return JSON.stringify({ object: { sha: "abc123" } })
      }
      return "{}"
    })

    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "first")
    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "second")

    const creates = gh.mock.calls.filter((call) => ((call[0] as string[]) ?? []).includes("POST"))
    const puts = gh.mock.calls.filter((call) => ((call[0] as string[]) ?? []).includes("PUT"))

    expect(branchChecks).toBe(1)
    expect(creates).toHaveLength(1)
    expect(puts).toHaveLength(2)
  })

  it("caches the branch when creation races with another writer", () => {
    const config = { state: { repo: "acme/kody-state", path: "widgets", branch: "kody-state" } }
    let branchChecks = 0

    gh.mockImplementation((args) => {
      const ghArgs = args as string[]
      if (ghArgs.includes("/repos/acme/kody-state/git/ref/heads/kody-state")) {
        branchChecks += 1
        throw new Error("Not Found (HTTP 404)")
      }
      if (ghArgs.includes("/repos/acme/kody-state")) return JSON.stringify({ default_branch: "main" })
      if (ghArgs.includes("/repos/acme/kody-state/git/ref/heads/main")) {
        return JSON.stringify({ object: { sha: "abc123" } })
      }
      if (ghArgs.includes("POST")) throw new Error("Reference already exists (HTTP 422)")
      return "{}"
    })

    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "first")
    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "second")

    const creates = gh.mock.calls.filter((call) => ((call[0] as string[]) ?? []).includes("POST"))
    const puts = gh.mock.calls.filter((call) => ((call[0] as string[]) ?? []).includes("PUT"))

    expect(branchChecks).toBe(1)
    expect(creates).toHaveLength(1)
    expect(puts).toHaveLength(2)
  })

  it("does not cache an unexpected branch check failure", () => {
    const config = { state: { repo: "acme/kody-state", path: "widgets" } }

    gh.mockImplementationOnce(() => {
      throw new Error("GitHub server error (HTTP 500)")
    })
    expect(() => writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "first")).toThrow("HTTP 500")

    gh.mockClear()
    gh.mockReturnValue("{}")
    writeStateText(config, "/tmp/repo", "tasks/issues/1/state.json", "{}\n", "second")

    const branchChecks = gh.mock.calls.filter((call) =>
      ((call[0] as string[]) ?? []).includes("/repos/acme/kody-state/git/ref/heads/main"),
    )
    const puts = gh.mock.calls.filter((call) => ((call[0] as string[]) ?? []).includes("PUT"))

    expect(branchChecks).toHaveLength(1)
    expect(puts).toHaveLength(1)
  })
})
