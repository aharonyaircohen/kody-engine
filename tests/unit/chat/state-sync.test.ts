import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { eventsFilePath, eventsStatePath } from "../../../src/chat/events.js"
import { sessionFilePath, sessionStatePath } from "../../../src/chat/session.js"
import {
  persistChatFilesToState,
  persistJsonlFileToState,
  syncChatFilesFromState,
  syncChatSessionFromState,
  syncJsonlFileFromState,
} from "../../../src/chat/state-sync.js"
import { gh as ghMock } from "../../../src/issue.js"
import type { StateRepoConfig } from "../../../src/stateRepo.js"

const gh = ghMock as unknown as ReturnType<typeof vi.fn>

const CONFIG: StateRepoConfig = {
  state: { repo: "https://github.com/acme/kody-state", path: "app-state" },
}

const SESSION_ID = "sess-abc"

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

function apiReadResponse(text: string, sha = "sha-read"): string {
  return JSON.stringify({ type: "file", encoding: "base64", content: b64(text), sha })
}

function apiReadError(message: string): never {
  throw new Error(message)
}

function isWriteCall(args: string[]): boolean {
  return args.includes("PUT")
}

function isReadCall(args: string[]): boolean {
  return args.includes("api") && !args.includes("PUT") && args.some((a) => a.includes("/contents/"))
}

function writePayload(call: readonly unknown[]): Record<string, unknown> {
  const opts = call[1] as { input?: string }
  return JSON.parse(opts.input ?? "{}") as Record<string, unknown>
}

describe("chat/state-sync: syncJsonlFileFromState", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-state-sync-"))
    vi.mocked(gh).mockReset()
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("no-ops when the state repo returns 404 (file missing upstream)", () => {
    vi.mocked(gh).mockImplementation(() => apiReadError("HTTP 404 Not Found"))
    const local = path.join(tmp, "s.jsonl")
    expect(() =>
      syncJsonlFileFromState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
      }),
    ).not.toThrow()
    expect(fs.existsSync(local)).toBe(false)
  })

  it("creates the local file (and parent dirs) with remote content when local is missing", () => {
    vi.mocked(gh).mockReturnValue(apiReadResponse('{"r":"u"}\n'))
    const local = path.join(tmp, "nested", "deeper", "s.jsonl")
    expect(fs.existsSync(local)).toBe(false)
    syncJsonlFileFromState({
      config: CONFIG,
      cwd: tmp,
      statePath: "sessions/x.jsonl",
      localPath: local,
    })
    expect(fs.readFileSync(local, "utf-8")).toBe('{"r":"u"}\n')
  })

  it("appends remote-only lines and deduplicates lines already present locally", () => {
    vi.mocked(gh).mockReturnValue(apiReadResponse('{"r":"u"}\n{"r":"a"}\n'))
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"u"}\n{"r":"x"}\n')
    syncJsonlFileFromState({
      config: CONFIG,
      cwd: tmp,
      statePath: "sessions/x.jsonl",
      localPath: local,
    })
    const lines = fs.readFileSync(local, "utf-8").trim().split("\n")
    // The duplicated {"r":"u"} line appears exactly once.
    expect(lines.filter((l) => l === '{"r":"u"}')).toHaveLength(1)
    expect(lines).toContain('{"r":"x"}')
    expect(lines).toContain('{"r":"a"}')
  })

  it("does not rewrite the local file when local already covers the remote content", () => {
    vi.mocked(gh).mockReturnValue(apiReadResponse('{"r":"u"}\n{"r":"a"}\n'))
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"a"}\n{"r":"u"}\n')
    const before = fs.statSync(local).mtimeMs
    // Sleep so mtime would change if a write happened. 25ms is well above
    // the filesystem mtime resolution on every supported runner.
    const t = Date.now()
    while (Date.now() - t < 25) {
      /* spin briefly */
    }
    syncJsonlFileFromState({
      config: CONFIG,
      cwd: tmp,
      statePath: "sessions/x.jsonl",
      localPath: local,
    })
    const after = fs.statSync(local).mtimeMs
    expect(after).toBe(before)
  })
})

describe("chat/state-sync: persistJsonlFileToState", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-state-sync-persist-"))
    vi.mocked(gh).mockReset()
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("no-ops when the local file does not exist (nothing to push)", () => {
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: path.join(tmp, "missing.jsonl"),
        message: "commit",
      }),
    ).not.toThrow()
    expect(vi.mocked(gh)).not.toHaveBeenCalled()
  })

  it("writes merged body + commit message + remote sha on first-attempt success", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) return apiReadResponse('{"r":"remote1"}\n')
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    persistJsonlFileToState({
      config: CONFIG,
      cwd: tmp,
      statePath: "sessions/x.jsonl",
      localPath: local,
      message: "commit msg",
    })
    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(1)
    const payload = writePayload(writes[0]!)
    expect(payload.message).toBe("commit msg")
    expect(payload.content).toBe(b64('{"r":"local1"}\n{"r":"remote1"}\n'))
    expect(payload.sha).toBe("sha-read")
  })

  it("retries on HTTP 409 and succeeds on the second attempt", () => {
    let putCalls = 0
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) return apiReadResponse('{"r":"remote1"}\n')
      if (isWriteCall(args)) {
        putCalls++
        if (putCalls === 1) throw new Error("HTTP 409 Conflict")
        return ""
      }
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
        message: "m",
      }),
    ).not.toThrow()
    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(2)
    expect(putCalls).toBe(2)
  })

  it("retries on HTTP 422 and succeeds on the second attempt", () => {
    let putCalls = 0
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) return apiReadResponse('{"r":"remote1"}\n')
      if (isWriteCall(args)) {
        putCalls++
        if (putCalls === 1) throw new Error("HTTP 422 Unprocessable Entity")
        return ""
      }
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
        message: "m",
      }),
    ).not.toThrow()
    expect(putCalls).toBe(2)
  })

  it("throws after 3 attempts when every PUT hits a conflict", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) return apiReadResponse('{"r":"remote1"}\n')
      if (isWriteCall(args)) throw new Error("HTTP 409 Conflict")
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
        message: "m",
      }),
    ).toThrow(/HTTP 409/)
    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(3)
  })

  it("throws immediately on a non-conflict error (no retry)", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) return apiReadResponse('{"r":"remote1"}\n')
      if (isWriteCall(args)) throw new Error("HTTP 500 Internal Server Error")
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
        message: "m",
      }),
    ).toThrow(/HTTP 500/)
    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(1)
  })

  it("retries when the conflict message uses 'does not match' wording", () => {
    let putCalls = 0
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) return apiReadResponse('{"r":"remote1"}\n')
      if (isWriteCall(args)) {
        putCalls++
        if (putCalls === 1) throw new Error("blob does not match expected sha")
        return ""
      }
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
        message: "m",
      }),
    ).not.toThrow()
    expect(putCalls).toBe(2)
  })

  it("uses no sha when the state repo has no prior file (first commit to a fresh path)", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) apiReadError("HTTP 404 Not Found")
      if (isWriteCall(args)) return ""
      return ""
    })
    const local = path.join(tmp, "s.jsonl")
    fs.writeFileSync(local, '{"r":"local1"}\n')
    expect(() =>
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/x.jsonl",
        localPath: local,
        message: "first",
      }),
    ).not.toThrow()
    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(1)
    const payload = writePayload(writes[0]!)
    expect(payload.message).toBe("first")
    expect(payload.content).toBe(b64('{"r":"local1"}\n'))
    // sha absent — stateRepoConfig never returned a prior version.
    expect(payload.sha).toBeUndefined()
  })
})

describe("chat/state-sync: composite helpers", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-state-sync-composite-"))
    vi.mocked(gh).mockReset()
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("syncChatFilesFromState syncs both the session and the events file", () => {
    const sessionLine = '{"r":"u-session"}\n'
    const eventsLine = '{"r":"u-events"}\n'
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (!isReadCall(args)) return ""
      const target = (args as string[]).find((a) => a.includes("/contents/")) ?? ""
      if (target.endsWith(sessionStatePath(SESSION_ID))) return apiReadResponse(sessionLine)
      if (target.endsWith(eventsStatePath(SESSION_ID))) return apiReadResponse(eventsLine)
      throw new Error(`unexpected path: ${target}`)
    })

    syncChatFilesFromState(CONFIG, tmp, SESSION_ID)

    expect(fs.readFileSync(sessionFilePath(tmp, SESSION_ID), "utf-8")).toBe(sessionLine)
    expect(fs.readFileSync(eventsFilePath(tmp, SESSION_ID), "utf-8")).toBe(eventsLine)
  })

  it("syncChatFilesFromState is a no-op when both upstream files are missing", () => {
    vi.mocked(gh).mockImplementation(() => apiReadError("HTTP 404 Not Found"))
    expect(() => syncChatFilesFromState(CONFIG, tmp, SESSION_ID)).not.toThrow()
    expect(fs.existsSync(sessionFilePath(tmp, SESSION_ID))).toBe(false)
    expect(fs.existsSync(eventsFilePath(tmp, SESSION_ID))).toBe(false)
  })

  it("syncChatSessionFromState syncs the session file only (not the events file)", () => {
    const sessionLine = '{"r":"u-session"}\n'
    let readCount = 0
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (!isReadCall(args)) return ""
      readCount++
      // The session-only helper must never read the events path.
      const target = (args as string[]).find((a) => a.includes("/contents/")) ?? ""
      expect(target).not.toContain(eventsStatePath(SESSION_ID))
      return apiReadResponse(sessionLine)
    })

    syncChatSessionFromState(CONFIG, tmp, SESSION_ID)

    expect(fs.readFileSync(sessionFilePath(tmp, SESSION_ID), "utf-8")).toBe(sessionLine)
    expect(fs.existsSync(eventsFilePath(tmp, SESSION_ID))).toBe(false)
    expect(readCount).toBe(1)
  })

  it("persistChatFilesToState pushes both files with the default commit message", () => {
    let putCount = 0
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) apiReadError("HTTP 404 Not Found")
      if (isWriteCall(args)) {
        putCount++
        return ""
      }
      return ""
    })
    fs.mkdirSync(path.dirname(sessionFilePath(tmp, SESSION_ID)), { recursive: true })
    fs.mkdirSync(path.dirname(eventsFilePath(tmp, SESSION_ID)), { recursive: true })
    fs.writeFileSync(sessionFilePath(tmp, SESSION_ID), '{"r":"localS"}\n')
    fs.writeFileSync(eventsFilePath(tmp, SESSION_ID), '{"r":"localE"}\n')

    persistChatFilesToState(CONFIG, tmp, SESSION_ID)

    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(2)
    expect(putCount).toBe(2)
    for (const w of writes) {
      const payload = writePayload(w)
      expect(payload.message).toBe(`chat: reply for ${SESSION_ID}`)
    }
  })

  it("persistChatFilesToState uses the caller-supplied message when provided", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) apiReadError("HTTP 404 Not Found")
      return ""
    })
    fs.mkdirSync(path.dirname(sessionFilePath(tmp, SESSION_ID)), { recursive: true })
    fs.mkdirSync(path.dirname(eventsFilePath(tmp, SESSION_ID)), { recursive: true })
    fs.writeFileSync(sessionFilePath(tmp, SESSION_ID), '{"r":"localS"}\n')
    fs.writeFileSync(eventsFilePath(tmp, SESSION_ID), '{"r":"localE"}\n')

    persistChatFilesToState(CONFIG, tmp, SESSION_ID, "manual: rerun")

    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    expect(writes).toHaveLength(2)
    for (const w of writes) {
      expect(writePayload(w).message).toBe("manual: rerun")
    }
  })

  it("persistChatFilesToState skips whichever local file is absent", () => {
    vi.mocked(gh).mockImplementation((args: string[]) => {
      if (isReadCall(args)) apiReadError("HTTP 404 Not Found")
      return ""
    })
    // Only the session file exists locally — the events file does not.
    fs.mkdirSync(path.dirname(sessionFilePath(tmp, SESSION_ID)), { recursive: true })
    fs.writeFileSync(sessionFilePath(tmp, SESSION_ID), '{"r":"localS"}\n')

    persistChatFilesToState(CONFIG, tmp, SESSION_ID)

    const writes = vi.mocked(gh).mock.calls.filter(([args]) => isWriteCall(args as string[]))
    // One for the session, zero for the events file (no local source).
    expect(writes).toHaveLength(1)
  })
})
