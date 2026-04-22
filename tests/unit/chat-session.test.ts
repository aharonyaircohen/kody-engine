import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendTurn, readSession, seedInitialMessage, sessionFilePath } from "../../src/chat/session.js"

describe("chat/session", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody2-chat-session-"))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("readSession returns [] when file does not exist", () => {
    expect(readSession(path.join(tmp, "missing.jsonl"))).toEqual([])
  })

  it("readSession parses valid JSONL turns and skips malformed lines", () => {
    const file = path.join(tmp, "s.jsonl")
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ role: "user", content: "hi", timestamp: "2025-01-01T00:00:00Z" }),
        "not json",
        JSON.stringify({ role: "assistant", content: "hello", timestamp: "2025-01-01T00:00:01Z" }),
        JSON.stringify({ role: "system", content: "ignored", timestamp: "x" }),
        "",
      ].join("\n"),
    )
    const turns = readSession(file)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.role).toBe("user")
    expect(turns[1]?.role).toBe("assistant")
  })

  it("appendTurn creates parent dirs and appends a JSON line", () => {
    const file = path.join(tmp, "nested", "dir", "s.jsonl")
    appendTurn(file, { role: "user", content: "one", timestamp: "t1" })
    appendTurn(file, { role: "assistant", content: "two", timestamp: "t2" })
    const turns = readSession(file)
    expect(turns).toHaveLength(2)
    expect(turns.map((t) => t.content)).toEqual(["one", "two"])
  })

  it("seedInitialMessage appends when session is empty", () => {
    const file = path.join(tmp, "s.jsonl")
    expect(seedInitialMessage(file, "first")).toBe(true)
    expect(readSession(file)).toHaveLength(1)
  })

  it("seedInitialMessage is idempotent when last turn matches", () => {
    const file = path.join(tmp, "s.jsonl")
    appendTurn(file, { role: "user", content: "same", timestamp: "t1" })
    expect(seedInitialMessage(file, "same")).toBe(false)
    expect(readSession(file)).toHaveLength(1)
  })

  it("seedInitialMessage skips empty message", () => {
    const file = path.join(tmp, "s.jsonl")
    expect(seedInitialMessage(file, "   ")).toBe(false)
    expect(readSession(file)).toEqual([])
  })

  it("sessionFilePath lives under .kody/sessions", () => {
    expect(sessionFilePath("/repo", "abc")).toBe(path.join("/repo", ".kody", "sessions", "abc.jsonl"))
  })
})
