import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import type { AgentResult } from "../../src/agent.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { gh as ghMock } from "../../src/issue.js"
import { openAgentFactoryStatePr, parseAgentFactoryBundle } from "../../src/scripts/openAgentFactoryStatePr.js"

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
    summary: "Creates a small example executable for review.",
    files: [
      {
        path: "executables/example/profile.json",
        content: "{\n  \"name\": \"example\"\n}\n",
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
    if (path.includes("/git/refs/heads/agent-factory/")) return JSON.stringify({})
    if (path.endsWith("/pulls")) return JSON.stringify({ html_url: "https://github.com/acme/kody-state/pull/7", number: 7 })
    if (args[0] === "issue" && args[1] === "comment") return ""
    throw new Error(`unexpected gh call: ${args.join(" ")}`)
  })
}

function inputForPath(pathSuffix: string): unknown {
  const call = gh.mock.calls.find((c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[]).some((arg) => arg.endsWith(pathSuffix)))
  if (!call) throw new Error(`no call for ${pathSuffix}`)
  return JSON.parse((call as [string[], { input: string }])[1].input)
}

describe("openAgentFactoryStatePr", () => {
  beforeEach(() => {
    gh.mockReset()
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
  })

  it("opens a PR in the configured state repo", async () => {
    mockSuccessfulGh()
    const ctx = makeCtx(bundle())

    await openAgentFactoryStatePr(ctx, profile, agentResult)

    expect(gh.mock.calls.some((call: unknown[]) => (call[0] as string[]).includes("/repos/acme/kody-state/pulls"))).toBe(true)
    expect(ctx.output.prUrl).toBe("https://github.com/acme/kody-state/pull/7")
    expect(ctx.data.agentFactoryStatePr).toMatchObject({
      repo: "acme/kody-state",
      url: "https://github.com/acme/kody-state/pull/7",
      base: "main",
    })
  })

  it("prefixes generated file paths with state.path", async () => {
    mockSuccessfulGh()

    await openAgentFactoryStatePr(makeCtx(bundle()), profile, agentResult)

    const tree = inputForPath("/git/trees") as { tree: Array<{ path: string; content: string }> }
    expect(tree.tree).toEqual([
      {
        path: "app-state/executables/example/profile.json",
        mode: "100644",
        type: "blob",
        content: "{\n  \"name\": \"example\"\n}\n",
      },
    ])
  })

  it("rejects empty files", () => {
    expect(() => parseAgentFactoryBundle(bundle({ files: [] }))).toThrow(/files must be a non-empty array/)
  })

  it("rejects unsafe paths", async () => {
    await expect(
      openAgentFactoryStatePr(
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

  it("strips legacy .kody prefixes from generated paths", async () => {
    mockSuccessfulGh()

    await openAgentFactoryStatePr(
      makeCtx(
        bundle({
          files: [{ path: ".kody/executables/example/profile.json", content: "{}\n" }],
        }),
      ),
      profile,
      agentResult,
    )

    const tree = inputForPath("/git/trees") as { tree: Array<{ path: string; content: string }> }
    expect(tree.tree[0]?.path).toBe("app-state/executables/example/profile.json")
  })
})
