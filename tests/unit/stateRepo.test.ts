import { beforeEach, describe, expect, it, vi } from "vitest"

const ghMock = vi.hoisted(() => vi.fn())

vi.mock("../../src/issue.js", () => ({
  gh: ghMock,
}))

import { STATE_BRANCH } from "../../src/stateBranch.js"
import { parseStateRepoSlug, readStateText, writeStateText } from "../../src/stateRepo.js"

function b64(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64")
}

beforeEach(() => {
  ghMock.mockReset()
})

describe("stateRepo: parseStateRepoSlug", () => {
  it("parses canonical full GitHub repository URLs", () => {
    expect(parseStateRepoSlug("https://github.com/o/kody-state")).toEqual({
      owner: "o",
      repo: "kody-state",
    })
  })

  it("parses canonical URLs with .git suffix", () => {
    expect(parseStateRepoSlug("https://github.com/o/kody-state.git")).toEqual({
      owner: "o",
      repo: "kody-state",
    })
  })

  it("keeps legacy owner/repo references readable", () => {
    expect(parseStateRepoSlug("o/kody-state")).toEqual({
      owner: "o",
      repo: "kody-state",
    })
  })

  it("rejects non-GitHub URLs", () => {
    expect(() => parseStateRepoSlug("https://example.com/o/kody-state")).toThrow(/github\.com/)
  })
})

describe("stateRepo branch", () => {
  const config = {
    state: { repo: "https://github.com/o/kody-state", path: "widgets" },
  }
  const configuredBranchConfig = {
    state: { repo: "https://github.com/o/kody-state", path: "widgets", branch: "main" },
  }
  const legacyBranchConfig = {
    state: { repo: "https://github.com/o/kody-state", path: "widgets", branch: "kody-state" },
  }

  it("reads runtime state from the dedicated state branch", () => {
    ghMock.mockReturnValue(
      JSON.stringify({
        type: "file",
        encoding: "base64",
        content: b64("hello"),
        sha: "file-sha",
      }),
    )

    const file = readStateText(config, "/repo", "reports/check.md")

    expect(file?.content).toBe("hello")
    expect(ghMock).toHaveBeenCalledWith(
      ["api", `/repos/o/kody-state/contents/widgets/reports/check.md?ref=${STATE_BRANCH}`],
      { cwd: "/repo" },
    )
  })

  it("reads runtime state from the configured state branch", () => {
    ghMock.mockReturnValue(
      JSON.stringify({
        type: "file",
        encoding: "base64",
        content: b64("hello"),
        sha: "file-sha",
      }),
    )

    readStateText(configuredBranchConfig, "/repo", "reports/check.md")

    expect(ghMock).toHaveBeenCalledWith(["api", "/repos/o/kody-state/contents/widgets/reports/check.md?ref=main"], {
      cwd: "/repo",
    })
  })

  it("creates a configured state branch on first write and writes to it", () => {
    let payload: Record<string, unknown> | null = null
    ghMock.mockImplementation((args: string[], opts?: { input?: string }) => {
      const command = args.join(" ")
      if (command === "api /repos/o/kody-state/git/ref/heads/kody-state") {
        throw new Error("HTTP 404 Not Found")
      }
      if (command === "api /repos/o/kody-state") {
        return JSON.stringify({ default_branch: "main" })
      }
      if (command === "api /repos/o/kody-state/git/ref/heads/main") {
        return JSON.stringify({ object: { sha: "main-sha" } })
      }
      if (command === "api --method POST /repos/o/kody-state/git/refs --input -") {
        return ""
      }
      if (command === "api --method PUT /repos/o/kody-state/contents/widgets/reports/check.md --input -") {
        payload = JSON.parse(String(opts?.input ?? "{}")) as Record<string, unknown>
        return ""
      }
      throw new Error(`unexpected gh call: ${command}`)
    })

    writeStateText(legacyBranchConfig, "/repo", "reports/check.md", "hello", "save report")

    expect(ghMock).toHaveBeenCalledWith(["api", "--method", "POST", "/repos/o/kody-state/git/refs", "--input", "-"], {
      cwd: "/repo",
      input: JSON.stringify({ ref: "refs/heads/kody-state", sha: "main-sha" }),
    })
    expect(payload).toMatchObject({
      message: "save report",
      branch: "kody-state",
      content: b64("hello"),
    })
  })

  it("writes runtime state to the configured state branch", () => {
    let payload: Record<string, unknown> | null = null
    ghMock.mockImplementation((args: string[], opts?: { input?: string }) => {
      const command = args.join(" ")
      if (command === "api /repos/o/kody-state/git/ref/heads/main") {
        return JSON.stringify({ object: { sha: "main-sha" } })
      }
      if (command === "api --method PUT /repos/o/kody-state/contents/widgets/reports/check.md --input -") {
        payload = JSON.parse(String(opts?.input ?? "{}")) as Record<string, unknown>
        return ""
      }
      throw new Error(`unexpected gh call: ${command}`)
    })

    writeStateText(configuredBranchConfig, "/repo", "reports/check.md", "hello", "save report")

    expect(payload).toMatchObject({
      message: "save report",
      branch: "main",
      content: b64("hello"),
    })
  })
})
