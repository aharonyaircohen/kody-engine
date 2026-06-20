/**
 * Unit coverage for the `worker-ask` preflight `loadWorkerAdhoc`.
 *
 * The script reads a persona file off disk and resolves the inline message
 * from either the dispatching `issue_comment` body (GITHUB_EVENT_PATH) or the
 * tokenized `ctx.args.message` fallback. We mock node:fs so the persona file
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
import { loadWorkerAdhoc } from "../../src/scripts/loadWorkerAdhoc.js"

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

describe("loadWorkerAdhoc: persona resolution", () => {
  it("reads persona, extracts H1 title + body, uses message-arg fallback", async () => {
    mocks.files.set(`${CWD}/.kody/staff/dr-bug.md`, "# Dr. Bug\n\nI hunt regressions.")
    const ctx = makeCtx({ worker: "dr-bug", message: "look at the flaky test", thread: "12" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.workerSlug).toBe("dr-bug")
    expect(ctx.data.workerTitle).toBe("Dr. Bug")
    expect(ctx.data.workerPersona).toBe("I hunt regressions.")
    expect(ctx.data.message).toBe("look at the flaky test")
    expect(ctx.data.thread).toBe("12")
  })

  it("strips frontmatter before parsing the H1 title", async () => {
    mocks.files.set(`${CWD}/.kody/staff/qa.md`, "---\nstaff: qa\n---\n# QA Lead\n\nBody here.")
    const ctx = makeCtx({ worker: "qa", message: "hi" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.workerTitle).toBe("QA Lead")
    expect(ctx.data.workerPersona).toBe("Body here.")
  })

  it("humanizes the slug when the persona has no H1", async () => {
    mocks.files.set(`${CWD}/.kody/staff/lead_dev.md`, "Just prose, no heading.")
    const ctx = makeCtx({ worker: "lead_dev", message: "hi" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.workerTitle).toBe("Lead Dev")
    expect(ctx.data.workerPersona).toBe("Just prose, no heading.")
  })

  it("honors a custom workersDir arg", async () => {
    mocks.files.set(`${CWD}/team/alice.md`, "# Alice")
    const ctx = makeCtx({ worker: "alice", message: "hi" })

    await loadWorkerAdhoc(ctx, profile, { workersDir: "team" })

    expect(ctx.data.workerSlug).toBe("alice")
    expect(ctx.data.workerTitle).toBe("Alice")
  })

  it("defaults thread to empty string when absent", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    const ctx = makeCtx({ worker: "x", message: "hi" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.thread).toBe("")
  })
})

describe("loadWorkerAdhoc: message from the dispatching comment", () => {
  it("prefers the verbatim comment body and strips the @kody worker-ask directive line", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    const event = { comment: { body: "@kody worker-ask x\nplease review\n\nwith code blocks" } }
    mocks.files.set("/event.json", JSON.stringify(event))
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ worker: "x", message: "ignored fallback" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("please review\n\nwith code blocks")
  })

  it("preserves a later @kody mention that is not the leading directive", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    const body = "@kody worker-ask x\nplease check\nthen ping @kody again"
    mocks.files.set("/event.json", JSON.stringify({ comment: { body } }))
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ worker: "x", message: "fallback" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("please check\nthen ping @kody again")
  })

  it("falls back to the message arg when the event file is missing on disk", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    process.env.GITHUB_EVENT_PATH = "/does-not-exist.json"
    const ctx = makeCtx({ worker: "x", message: "from arg" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("from arg")
  })

  it("falls back to the message arg when the event JSON is malformed", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    mocks.files.set("/event.json", "{ not json")
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ worker: "x", message: "from arg" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("from arg")
  })

  it("falls back to the message arg when the event has no comment body", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    mocks.files.set("/event.json", JSON.stringify({ comment: {} }))
    process.env.GITHUB_EVENT_PATH = "/event.json"
    const ctx = makeCtx({ worker: "x", message: "from arg" })

    await loadWorkerAdhoc(ctx, profile)

    expect(ctx.data.message).toBe("from arg")
  })
})

describe("loadWorkerAdhoc: validation errors", () => {
  it("throws when ctx.args.worker is empty", async () => {
    const ctx = makeCtx({ worker: "  ", message: "hi" })

    await expect(loadWorkerAdhoc(ctx, profile)).rejects.toThrow(/non-empty slug/)
  })

  it("throws when the persona file does not exist", async () => {
    const ctx = makeCtx({ worker: "ghost", message: "hi" })

    await expect(loadWorkerAdhoc(ctx, profile)).rejects.toThrow(/persona not found/)
  })

  it("throws when no message is available from either source", async () => {
    mocks.files.set(`${CWD}/.kody/staff/x.md`, "# X")
    const ctx = makeCtx({ worker: "x" })

    await expect(loadWorkerAdhoc(ctx, profile)).rejects.toThrow(/no message/)
  })
})
