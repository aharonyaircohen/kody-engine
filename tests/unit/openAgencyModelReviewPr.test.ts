import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/implementations/types.js"
import { gh as ghMock } from "../../src/issue.js"
import { openAgencyModelReviewPr, parseAgencyModelProposal } from "../../src/scripts/openAgencyModelReviewPr.js"

const gh = ghMock as unknown as ReturnType<typeof vi.fn>
const profile = {} as Profile
const agentResult: AgentResult = {
  outcome: "completed",
  outcomeKind: "ok",
  finalText: "",
  ndjsonPath: "/tmp/agent.ndjson",
}

function makeCtx(prSummary: string): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp/consumer",
    config: {
      github: { owner: "consumer", repo: "app" },
      state: { repo: "acme/kody-state", path: "app-state" },
      git: { defaultBranch: "main" },
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      agent: { model: "claude/sonnet" },
    },
    data: {
      agentDone: true,
      prSummary,
    },
    output: { exitCode: 0 },
  }
}

function bundle(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Add example agent",
    summary: "Creates a small example capability for review.",
    files: [
      {
        path: "capabilities/example/profile.json",
        content: '{\n  "name": "example"\n}\n',
      },
    ],
    ...overrides,
  })
}

function mockSuccessfulGh(): void {
  gh.mockImplementation((args: string[]) => {
    const path = args.find((arg) => arg.startsWith("/repos/")) ?? ""
    if (path.includes("/git/ref/heads/main")) return JSON.stringify({ object: { sha: "base-commit" } })
    if (path.includes("/git/commits/base-commit")) return JSON.stringify({ tree: { sha: "base-tree" } })
    if (path.endsWith("/git/refs")) return JSON.stringify({})
    if (path.endsWith("/git/trees")) return JSON.stringify({ sha: "new-tree" })
    if (path.endsWith("/git/commits")) return JSON.stringify({ sha: "new-commit" })
    if (path.includes("/git/refs/heads/")) return JSON.stringify({})
    if (path.endsWith("/pulls"))
      return JSON.stringify({ html_url: "https://github.com/acme/kody-state/pull/7", number: 7 })
    if (args[0] === "issue" && args[1] === "comment") return ""
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  })
}

function inputForPath(pathSuffix: string): unknown {
  const call = gh.mock.calls.find(
    (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[]).some((arg) => arg.endsWith(pathSuffix)),
  )
  if (!call) throw new Error(`no call for ${pathSuffix}`)
  return JSON.parse((call as [string[], { input: string }])[1].input)
}

describe("openAgencyModelReviewPr", () => {
  beforeEach(() => {
    gh.mockReset()
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
  })

  it("opens a PR in the configured state repo", async () => {
    mockSuccessfulGh()
    const ctx = makeCtx(bundle())

    await openAgencyModelReviewPr(ctx, profile, agentResult)

    expect(
      gh.mock.calls.some((call: unknown[]) => (call[0] as string[]).includes("/repos/acme/kody-state/pulls")),
    ).toBe(true)
    expect(ctx.output.prUrl).toBe("https://github.com/acme/kody-state/pull/7")
    expect(ctx.data.agencyModelReviewPr).toMatchObject({
      repo: "acme/kody-state",
      url: "https://github.com/acme/kody-state/pull/7",
      base: "main",
    })
  })

  it("prefixes generated file paths with state.path", async () => {
    mockSuccessfulGh()

    await openAgencyModelReviewPr(makeCtx(bundle()), profile, agentResult)

    const tree = inputForPath("/git/trees") as { tree: Array<{ path: string; content: string }> }
    expect(tree.tree).toEqual([
      {
        path: "app-state/capabilities/example/profile.json",
        mode: "100644",
        type: "blob",
        content: '{\n  "name": "example"\n}\n',
      },
    ])
  })

  it("uses the actual creator capability in state PR title and issue comment", async () => {
    mockSuccessfulGh()
    const ctx = makeCtx(bundle({ title: "Add example workflow" }))
    ctx.data.jobCapability = "workflow-creator"

    await openAgencyModelReviewPr(ctx, { name: "workflow-creator" } as Profile, agentResult)

    const commit = inputForPath("/git/commits") as { message: string }
    expect(commit.message).toBe("workflow-creator: Add example workflow")
    const pull = inputForPath("/pulls") as { title: string; body: string }
    expect(pull.title).toBe("workflow-creator: Add example workflow")
    expect(pull.body).toContain("workflow-creator generated Kody agency model changes")
    const commentCall = gh.mock.calls.find(
      (call: unknown[]) =>
        Array.isArray(call[0]) && (call[0] as string[]).join(" ") === "issue comment 42 --body-file -",
    )
    expect((commentCall as [string[], { input: string }])[1].input).toContain(
      "workflow-creator opened a state-repo review PR",
    )
  })

  it("rejects empty files", () => {
    expect(() => parseAgencyModelProposal(bundle({ files: [] }))).toThrow(/files must be a non-empty array/)
  })

  it("rejects unsafe paths", async () => {
    await expect(
      openAgencyModelReviewPr(
        makeCtx(
          bundle({
            files: [{ path: "../secret", content: "nope" }],
          }),
        ),
        profile,
        agentResult,
      ),
    ).rejects.toThrow(/relative path/)
  })

  it("strips .kody prefixes from generated paths", async () => {
    mockSuccessfulGh()

    await openAgencyModelReviewPr(
      makeCtx(
        bundle({
          files: [{ path: ".kody/capabilities/example/profile.json", content: "{}\n" }],
        }),
      ),
      profile,
      agentResult,
    )

    const tree = inputForPath("/git/trees") as { tree: Array<{ path: string; content: string }> }
    expect(tree.tree[0]?.path).toBe("app-state/capabilities/example/profile.json")
  })

  it("rejects obsolete implementation paths", async () => {
    await expect(
      openAgencyModelReviewPr(
        makeCtx(
          bundle({
            files: [{ path: "implementations/example/profile.json", content: "{}\n" }],
          }),
        ),
        profile,
        agentResult,
      ),
    ).rejects.toThrow(/obsolete implementations storage/)
  })
})
