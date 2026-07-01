import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  postIssueComment: vi.fn(),
  postPrReviewComment: vi.fn(),
  setKodyLabel: vi.fn(),
  reactToTriggerComment: vi.fn(),
  runJob: vi.fn(),
}))

vi.mock("../../src/issue.js", () => ({
  postIssueComment: mocks.postIssueComment,
  postPrReviewComment: mocks.postPrReviewComment,
  truncate: (value: string) => value,
}))

vi.mock("../../src/lifecycleLabels.js", () => ({
  setKodyLabel: mocks.setKodyLabel,
}))

vi.mock("../../src/gha.js", () => ({
  reactToTriggerComment: mocks.reactToTriggerComment,
}))

vi.mock("../../src/job.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/job.js")>("../../src/job.js")
  return {
    ...actual,
    runJob: mocks.runJob,
  }
})

import { runCi } from "../../src/kody-cli.js"

function writeEvent(body: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kody-cli-rejected-dispatch-"))
  const p = path.join(dir, "event.json")
  fs.writeFileSync(p, JSON.stringify(body))
  return p
}

const prevEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ["GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GH_TOKEN", "GITHUB_TOKEN", "KODY_TOKEN"]) {
    prevEnv[key] = process.env[key]
  }
  process.env.GH_TOKEN = "test-token"
  mocks.postIssueComment.mockReset()
  mocks.postPrReviewComment.mockReset()
  mocks.setKodyLabel.mockReset()
  mocks.reactToTriggerComment.mockReset()
  mocks.runJob.mockReset()
})

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.restoreAllMocks()
})

describe("kody-cli: rejected dispatch", () => {
  it("marks bot-authored @kody command comments as terminal instead of exiting cleanly", async () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        body: "**Kody**\n\n@kody implement issue 674",
        user: { login: "kodyade[bot]", type: "Bot" },
      },
      issue: { number: 674 },
    })

    await expect(runCi(["--cwd", process.cwd(), "--skip-install", "--skip-litellm"])).resolves.toBe(64)

    expect(mocks.postIssueComment).toHaveBeenCalledTimes(1)
    expect(mocks.postIssueComment.mock.calls[0]?.[0]).toBe(674)
    expect(String(mocks.postIssueComment.mock.calls[0]?.[1])).toContain("bot-authored `@kody implement`")
    expect(mocks.postPrReviewComment).not.toHaveBeenCalled()
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(
      674,
      expect.objectContaining({ label: "kody:failed" }),
      process.cwd(),
    )
  })
})

describe("kody-cli: early run failures", () => {
  it("marks crash-class run failures as failed so Dashboard does not return them to backlog", async () => {
    process.env.GITHUB_EVENT_NAME = "issue_comment"
    process.env.GITHUB_EVENT_PATH = writeEvent({
      comment: {
        body: "@kody run",
        user: { login: "aguyaharonyair", type: "User" },
        author_association: "OWNER",
      },
      issue: { number: 673 },
    })
    mocks.runJob.mockResolvedValueOnce({
      exitCode: 99,
      reason: "loadSubagents: agent 'research-scout' not found",
    })

    await expect(runCi(["--cwd", process.cwd(), "--skip-install", "--skip-litellm"])).resolves.toBe(99)

    expect(mocks.postIssueComment).toHaveBeenCalledTimes(1)
    expect(mocks.postIssueComment.mock.calls[0]?.[0]).toBe(673)
    expect(String(mocks.postIssueComment.mock.calls[0]?.[1])).toContain("loadSubagents")
    expect(mocks.setKodyLabel).toHaveBeenCalledWith(
      673,
      expect.objectContaining({ label: "kody:failed" }),
      process.cwd(),
    )
  })
})
