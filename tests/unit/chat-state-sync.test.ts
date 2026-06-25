import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  persistChatFilesToState,
  persistJsonlFileToState,
  syncChatFilesFromState,
  syncChatSessionFromState,
  syncJsonlFileFromState,
} from "../../src/chat/state-sync.js"
import { eventsFilePath, eventsStatePath } from "../../src/chat/events.js"
import { sessionFilePath, sessionStatePath } from "../../src/chat/session.js"

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, execFileSync: vi.fn() }
})

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>

const CONFIG = {
  github: { owner: "acme", repo: "kody-state" },
  state: { repo: "https://github.com/acme/kody-state", path: "main" },
}

function makeContentsFile(content: string, sha = "remote-sha"): string {
  return JSON.stringify({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha,
  })
}

function makeContentsMissing(): string {
  return JSON.stringify({ type: "file", encoding: "base64", content: "", sha: "missing-sha" })
}

describe("chat/state-sync", () => {
  let tmp: string
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-state-sync-"))
    mockedExec.mockReset()
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
    stderrSpy.mockRestore()
  })

  describe("syncJsonlFileFromState", () => {
    it("does nothing when remote has no content", () => {
      mockedExec.mockImplementation(() => makeContentsMissing())
      const local = path.join(tmp, "local.jsonl")
      syncJsonlFileFromState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: local,
      })
      expect(fs.existsSync(local)).toBe(false)
    })

    it("writes merged JSONL when remote has new lines", () => {
      const existing = JSON.stringify({ role: "user", content: "hi" })
      mockedExec.mockImplementation(() => makeContentsFile(existing, "remote-sha"))
      const local = path.join(tmp, "local.jsonl")
      syncJsonlFileFromState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: local,
      })
      expect(fs.existsSync(local)).toBe(true)
      const lines = fs.readFileSync(local, "utf-8").trim().split("\n")
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!).content).toBe("hi")
    })

    it("merges remote-only lines into existing local file without duplicating shared lines", () => {
      const localLine = JSON.stringify({ role: "user", content: "shared" })
      const remoteOnly = JSON.stringify({ role: "assistant", content: "new" })
      const remote = `${localLine}\n${remoteOnly}`
      fs.writeFileSync(path.join(tmp, "local.jsonl"), `${localLine}\n`)
      mockedExec.mockImplementation(() => makeContentsFile(remote, "remote-sha"))
      const local = path.join(tmp, "local.jsonl")
      syncJsonlFileFromState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: local,
      })
      const text = fs.readFileSync(local, "utf-8")
      expect(text).toContain(localLine)
      expect(text).toContain(remoteOnly)
      // shared line must not duplicate
      expect(text.match(/shared/g)).toHaveLength(1)
    })

    it("skips write when merged content equals existing local file", () => {
      const line = JSON.stringify({ role: "user", content: "only" })
      fs.writeFileSync(path.join(tmp, "local.jsonl"), `${line}\n`)
      const before = fs.statSync(path.join(tmp, "local.jsonl")).mtimeMs
      mockedExec.mockImplementation(() => makeContentsFile(`${line}\n`, "remote-sha"))
      // bump mtime check by sleeping briefly would be flaky; rely on the
      // `if (next === local) return` guard inside the function — the file
      // is not touched, so its content stays the same.
      syncJsonlFileFromState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: path.join(tmp, "local.jsonl"),
      })
      const after = fs.statSync(path.join(tmp, "local.jsonl")).mtimeMs
      expect(after).toBe(before)
    })

    it("creates parent directories if local file does not exist", () => {
      const line = JSON.stringify({ role: "user", content: "x" })
      mockedExec.mockImplementation(() => makeContentsFile(`${line}\n`, "remote-sha"))
      const local = path.join(tmp, "nested", "deeper", "local.jsonl")
      syncJsonlFileFromState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: local,
      })
      expect(fs.existsSync(local)).toBe(true)
    })
  })

  describe("persistJsonlFileToState", () => {
    it("returns silently when local file does not exist", () => {
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: path.join(tmp, "missing.jsonl"),
        message: "noop",
      })
      expect(mockedExec).not.toHaveBeenCalled()
    })

    it("writes merged JSONL with remote sha to the state repo", () => {
      const localLine = JSON.stringify({ role: "user", content: "u" })
      fs.writeFileSync(path.join(tmp, "local.jsonl"), `${localLine}\n`)
      const remoteText = JSON.stringify({ role: "system", content: "r" })
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        if (a.includes("PUT")) return ""
        if (a[0] === "api") return makeContentsFile(`${remoteText}\n`, "remote-sha")
        return ""
      })
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: path.join(tmp, "local.jsonl"),
        message: "persist",
      })
      const putCall = mockedExec.mock.calls.find((c) => ((c[1] as string[]) ?? []).includes("PUT"))
      expect(putCall).toBeDefined()
      const body = JSON.parse((putCall?.[2] as { input: string }).input)
      const written = Buffer.from(body.content, "base64").toString("utf-8")
      expect(written).toContain(localLine)
      expect(written).toContain(remoteText)
      expect(body.sha).toBe("remote-sha")
      expect(body.message).toBe("persist")
    })

    it("retries on conflict and gives up after the third attempt", () => {
      const localLine = JSON.stringify({ role: "user", content: "u" })
      fs.writeFileSync(path.join(tmp, "local.jsonl"), `${localLine}\n`)
      let reads = 0
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        if (a.includes("PUT")) {
          throw new Error("HTTP 409 Conflict")
        }
        if (a[0] === "api") {
          reads += 1
          return makeContentsFile("", `sha-${reads}`)
        }
        return ""
      })
      expect(() =>
        persistJsonlFileToState({
          config: CONFIG,
          cwd: tmp,
          statePath: "sessions/s1.jsonl",
          localPath: path.join(tmp, "local.jsonl"),
          message: "persist",
        }),
      ).toThrow(/HTTP 409/)
      // 3 PUT attempts, each preceded by a read = 3 reads + 3 puts.
      const puts = mockedExec.mock.calls.filter((c) => ((c[1] as string[]) ?? []).includes("PUT"))
      expect(puts).toHaveLength(3)
    })

    it("merges against an empty remote when remote has no content", () => {
      const localLine = JSON.stringify({ role: "user", content: "u" })
      fs.writeFileSync(path.join(tmp, "local.jsonl"), `${localLine}\n`)
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        if (a.includes("PUT")) return ""
        if (a[0] === "api") return makeContentsMissing()
        return ""
      })
      persistJsonlFileToState({
        config: CONFIG,
        cwd: tmp,
        statePath: "sessions/s1.jsonl",
        localPath: path.join(tmp, "local.jsonl"),
        message: "persist",
      })
      const putCall = mockedExec.mock.calls.find((c) => ((c[1] as string[]) ?? []).includes("PUT"))
      expect(putCall).toBeDefined()
      const body = JSON.parse((putCall?.[2] as { input: string }).input)
      const written = Buffer.from(body.content, "base64").toString("utf-8")
      expect(written).toContain(localLine)
    })
  })

  describe("syncChatFilesFromState", () => {
    it("hydrates both session and events JSONL files from the state repo", () => {
      const sessionLine = JSON.stringify({ role: "user", content: "s" })
      const eventsLine = JSON.stringify({ event: "chat.message" })
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        const last = a[a.length - 1] ?? ""
        if (last.endsWith("sessions/s1.jsonl")) return makeContentsFile(`${sessionLine}\n`, "s-sha")
        if (last.endsWith("events/s1.jsonl")) return makeContentsFile(`${eventsLine}\n`, "e-sha")
        return makeContentsMissing()
      })
      syncChatFilesFromState(CONFIG, tmp, "s1")
      expect(fs.existsSync(sessionFilePath(tmp, "s1"))).toBe(true)
      expect(fs.existsSync(eventsFilePath(tmp, "s1"))).toBe(true)
    })

    it("hydrates only the session file via syncChatSessionFromState", () => {
      const sessionLine = JSON.stringify({ role: "user", content: "s" })
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        const last = a[a.length - 1] ?? ""
        if (last.endsWith("sessions/s1.jsonl")) return makeContentsFile(`${sessionLine}\n`, "s-sha")
        return makeContentsMissing()
      })
      syncChatSessionFromState(CONFIG, tmp, "s1")
      expect(fs.existsSync(sessionFilePath(tmp, "s1"))).toBe(true)
      expect(fs.existsSync(eventsFilePath(tmp, "s1"))).toBe(false)
    })

    it("state paths use posix separators regardless of host OS", () => {
      const sessionLine = JSON.stringify({ role: "user", content: "s" })
      let sawSessionsPath = false
      let sawEventsPath = false
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        const last = a[a.length - 1] ?? ""
        // Confirm both paths are posix (forward slashes only, even on Windows).
        if (last.includes("sessions/s1.jsonl")) {
          expect(last).not.toContain("\\")
          sawSessionsPath = true
          return makeContentsFile(`${sessionLine}\n`, "s-sha")
        }
        if (last.includes("events/s1.jsonl")) {
          expect(last).not.toContain("\\")
          sawEventsPath = true
          return makeContentsFile("", "e-sha")
        }
        return makeContentsMissing()
      })
      syncChatFilesFromState(CONFIG, tmp, "s1")
      expect(sawSessionsPath).toBe(true)
      expect(sawEventsPath).toBe(true)
      // helpers used internally should produce the same posix form
      expect(sessionStatePath("s1")).toBe("sessions/s1.jsonl")
      expect(eventsStatePath("s1")).toBe("events/s1.jsonl")
    })
  })

  describe("persistChatFilesToState", () => {
    it("persists both session and events files with the default commit message", () => {
      const sessionLine = JSON.stringify({ role: "user", content: "s" })
      const eventsLine = JSON.stringify({ event: "chat.message" })
      fs.mkdirSync(path.dirname(sessionFilePath(tmp, "s1")), { recursive: true })
      fs.mkdirSync(path.dirname(eventsFilePath(tmp, "s1")), { recursive: true })
      fs.writeFileSync(sessionFilePath(tmp, "s1"), `${sessionLine}\n`)
      fs.writeFileSync(eventsFilePath(tmp, "s1"), `${eventsLine}\n`)
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        if (a.includes("PUT")) return ""
        if (a[0] === "api") return makeContentsMissing()
        return ""
      })
      persistChatFilesToState(CONFIG, tmp, "s1")
      const puts = mockedExec.mock.calls.filter((c) => ((c[1] as string[]) ?? []).includes("PUT"))
      expect(puts).toHaveLength(2)
      const messages = puts.map((c) => JSON.parse((c[2] as { input: string }).input).message as string)
      expect(messages).toEqual([`chat: reply for s1`, `chat: reply for s1`])
    })

    it("uses a custom commit message when provided", () => {
      const sessionLine = JSON.stringify({ role: "user", content: "s" })
      fs.mkdirSync(path.dirname(sessionFilePath(tmp, "s1")), { recursive: true })
      fs.writeFileSync(sessionFilePath(tmp, "s1"), `${sessionLine}\n`)
      mockedExec.mockImplementation((_cmd: unknown, args: unknown) => {
        const a = (args as string[]) ?? []
        if (a.includes("PUT")) return ""
        if (a[0] === "api") return makeContentsMissing()
        return ""
      })
      persistChatFilesToState(CONFIG, tmp, "s1", "custom commit")
      const put = mockedExec.mock.calls.find((c) => ((c[1] as string[]) ?? []).includes("PUT"))
      const body = JSON.parse((put?.[2] as { input: string }).input)
      expect(body.message).toBe("custom commit")
    })
  })
})