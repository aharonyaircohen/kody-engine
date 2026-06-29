/**
 * Unit coverage for the `agent-ask` preflight `loadAgentAdhoc`.
 *
 * The script reads an agent file off disk and resolves the inline message
 * from either the dispatching `issue_comment` body (GITHUB_EVENT_PATH) or the
 * tokenized `ctx.args.message` fallback. We mock node:fs so the agent file
 * and the event file are fully controlled, then assert on what lands in
 * ctx.data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// vi.mock is hoisted; vi.hoisted lets the factory share spies/state.
const mocks = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    files,
    existsSync: vi.fn((p: string) => files.has(String(p))),
    readFileSync: vi.fn((p: string) => {
      const got = files.get(String(p))
      if (got === undefined) throw new Error(`ENOENT: ${p}`)
      return got
    }),
  }
})

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}))

import { resetCompanyStoreCacheForTests } from "../../src/companyStore.js"
import type { Context, Profile } from "../../src/executables/types.js"
import { loadAgentAdhoc } from "../../src/scripts/loadAgentAdhoc.js"

const CWD = "/repo"

function makeCtx(args: Record<string, unknown>): Context {
  return {
    args,
    cwd: CWD,
    config: { github: { owner: "o", repo: "r" } } as never,
    data: {},
    output: { exitCode: 0 },
  } as Context
}

const profile = {} as Profile

beforeEach(() => {
  vi.stubEnv("KODY_COMPANY_STORE", "0")
  resetCompanyStoreCacheForTests()
  mocks.files.clear()
  mocks.existsSync.mockClear()
  mocks.readFileSync.mockClear()
  delete process.env.GITHUB_EVENT_PATH
})

afterEach(() => {
  delete process.env.GITHUB_EVENT_PATH
  vi.unstubAllEnvs()
  resetCompanyStoreCacheForTests()
})

describe("loadAgentAdhoc: agent resolution", () => {
  it("reads agent, extracts H1 title + body, uses message-arg fallback", async () => {
    mocks.files.set(`${CWD}/.kody/agents/dr-bug.md`, "# Dr. Bug\n\nI hunt regressions.")
    const ctx = makeCtx({ agent: "dr-bug", message: "look at the flaky test", thread: "12" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.agentSlug).toBe("dr-bug")
    expect(ctx.data.agentTitle).toBe("Dr. Bug")
    expect(ctx.data.agentIdentity).toBe("I hunt regressions.")
    expect(ctx.data.message).toBe("look at the flaky test")
    expect(ctx.data.thread).toBe("12")
  })

  it("strips frontmatter before parsing the H1 title", async () => {
    mocks.files.set(`${CWD}/.kody/agents/qa.md`, "---\nagent: qa\n---\n# QA Lead\n\nBody here.")
    const ctx = makeCtx({ agent: "qa", message: "hi" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.agentTitle).toBe("QA Lead")
    expect(ctx.data.agentIdentity).toBe("Body here.")
  })

  it("humanizes the slug when the agent has no H1", async () => {
    mocks.files.set(`${CWD}/.kody/agents/lead_dev.md`, "Just prose, no heading.")
    const ctx = makeCtx({ agent: "lead_dev", message: "hi" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.agentTitle).toBe("Lead Dev")
    expect(ctx.data.agentIdentity).toBe("Just prose, no heading.")
  })

  it("honors a custom agentsDir arg", async () => {
    mocks.files.set(`${CWD}/team/alice.md`, "# Alice")
    const ctx = makeCtx({ agent: "alice", message: "hi" })

    await loadAgentAdhoc(ctx, profile, { agentsDir: "team" })

    expect(ctx.data.agentSlug).toBe("alice")
    expect(ctx.data.agentTitle).toBe("Alice")
  })

  it("defaults thread to empty string when absent", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    const ctx = makeCtx({ agent: "x", message: "hi" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.thread).toBe("")
  })
})

describe("loadAgentAdhoc: message from the dispatching comment", () => {
  it("prefers the verbatim comment body and strips the @kody agent-ask directive line", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    const event = { comment: { body: "@kody agent-ask x\nplease review\n\nwith code blocks" } }
    mocks.files.set("/event.json", JSON.stringify(event))
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ agent: "x", message: "ignored fallback" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("please review\n\nwith code blocks")
  })

  it("preserves a later @kody mention that is not the leading directive", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    const body = "@kody agent-ask x\nplease check\nthen ping @kody again"
    mocks.files.set("/event.json", JSON.stringify({ comment: { body } }))
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ agent: "x", message: "fallback" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("please check\nthen ping @kody again")
  })

  it("falls back to the message arg when the event file is missing on disk", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    process.env.GITHUB_EVENT_PATH = "/does-not-exist.json"
    const ctx = makeCtx({ agent: "x", message: "from arg" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("from arg")
  })

  it("falls back to the message arg when the event JSON is malformed", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    mocks.files.set("/event.json", "{ not json")
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ agent: "x", message: "from arg" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("from arg")
  })

  it("falls back to the message arg when the event has no comment body", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    mocks.files.set("/event.json", JSON.stringify({ comment: {} }))
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ agent: "x", message: "from arg" })

    await loadAgentAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("from arg")
  })
})

describe("loadAgentAdhoc: validation errors", () => {
  it("throws when ctx.args.agent is empty", async () => {
    const ctx = makeCtx({ agent: "  ", message: "hi" })

    await expect(loadAgentAdhoc(ctx, profile)).rejects.toThrow(/non-empty slug/)
  })

  it("throws when the agent file does not exist", async () => {
    const ctx = makeCtx({ agent: "ghost", message: "hi" })

    await expect(loadAgentAdhoc(ctx, profile)).rejects.toThrow(/agent identity not found/)
  })

  it("throws when no message is available from either source", async () => {
    mocks.files.set(`${CWD}/.kody/agents/x.md`, "# X")
    const ctx = makeCtx({ agent: "x" })

    await expect(loadAgentAdhoc(ctx, profile)).rejects.toThrow(/no message/)
  })
})
