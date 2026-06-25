import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StateRepoConfig } from "../../src/stateRepo.js"

vi.mock("../../src/stateRepo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/stateRepo.js")>()
  return {
    ...actual,
    readStateText: vi.fn(),
    writeStateText: vi.fn(),
  }
})

import { eventsFilePath } from "../../src/chat/events.js"
import { sessionFilePath } from "../../src/chat/session.js"
import {
  persistChatFilesToState,
  persistJsonlFileToState,
  syncChatFilesFromState,
  syncJsonlFileFromState,
} from "../../src/chat/state-sync.js"
import { readStateText, writeStateText } from "../../src/stateRepo.js"

const readStateTextMock = vi.mocked(readStateText)
const writeStateTextMock = vi.mocked(writeStateText)

describe("chat/state-sync", () => {
  let tmp: string
  const config: StateRepoConfig = {
    github: { owner: "owner", repo: "repo" },
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-state-sync-"))
    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("syncs remote JSONL into the local cache without duplicating existing lines", () => {
    const localPath = path.join(tmp, ".kody", "sessions", "s1.jsonl")
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    fs.writeFileSync(localPath, '{"id":1}\n')
    readStateTextMock.mockReturnValue({
      path: "repo/sessions/s1.jsonl",
      content: '{"id":1}\n{"id":2}\n',
      sha: "sha1",
    })

    syncJsonlFileFromState({
      config,
      cwd: tmp,
      statePath: "sessions/s1.jsonl",
      localPath,
    })

    expect(fs.readFileSync(localPath, "utf-8")).toBe('{"id":1}\n{"id":2}\n')
  })

  it("skips sync when the remote state file does not exist", () => {
    const localPath = path.join(tmp, ".kody", "sessions", "missing.jsonl")
    readStateTextMock.mockReturnValue(null)

    syncJsonlFileFromState({
      config,
      cwd: tmp,
      statePath: "sessions/missing.jsonl",
      localPath,
    })

    expect(fs.existsSync(localPath)).toBe(false)
  })

  it("persists local JSONL and retries once when the state repo changed", () => {
    const localPath = path.join(tmp, ".kody", "sessions", "s1.jsonl")
    fs.mkdirSync(path.dirname(localPath), { recursive: true })
    fs.writeFileSync(localPath, '{"id":1}\n')
    readStateTextMock
      .mockReturnValueOnce({
        path: "repo/sessions/s1.jsonl",
        content: '{"id":2}\n',
        sha: "old-sha",
      })
      .mockReturnValueOnce({
        path: "repo/sessions/s1.jsonl",
        content: '{"id":2}\n{"id":3}\n',
        sha: "new-sha",
      })
    writeStateTextMock.mockImplementationOnce(() => {
      throw new Error("HTTP 409 Conflict")
    })

    persistJsonlFileToState({
      config,
      cwd: tmp,
      statePath: "sessions/s1.jsonl",
      localPath,
      message: "chat: persist",
    })

    expect(writeStateTextMock).toHaveBeenCalledTimes(2)
    expect(writeStateTextMock).toHaveBeenLastCalledWith(
      config,
      tmp,
      "sessions/s1.jsonl",
      '{"id":1}\n{"id":2}\n{"id":3}\n',
      "chat: persist",
      "new-sha",
    )
  })

  it("skips persist when the local cache file does not exist", () => {
    persistJsonlFileToState({
      config,
      cwd: tmp,
      statePath: "sessions/missing.jsonl",
      localPath: path.join(tmp, ".kody", "sessions", "missing.jsonl"),
      message: "chat: persist",
    })

    expect(readStateTextMock).not.toHaveBeenCalled()
    expect(writeStateTextMock).not.toHaveBeenCalled()
  })

  it("syncs and persists the chat session and events files together", () => {
    readStateTextMock.mockImplementation((_config, _cwd, statePath) => ({
      path: `repo/${statePath}`,
      content: statePath.startsWith("sessions/") ? '{"role":"user"}\n' : '{"type":"message"}\n',
      sha: `sha-${statePath}`,
    }))

    syncChatFilesFromState(config, tmp, "s1")
    expect(fs.readFileSync(sessionFilePath(tmp, "s1"), "utf-8")).toBe('{"role":"user"}\n')
    expect(fs.readFileSync(eventsFilePath(tmp, "s1"), "utf-8")).toBe('{"type":"message"}\n')

    persistChatFilesToState(config, tmp, "s1", "chat: persist both")
    expect(writeStateTextMock).toHaveBeenCalledWith(
      config,
      tmp,
      "sessions/s1.jsonl",
      '{"role":"user"}\n',
      "chat: persist both",
      "sha-sessions/s1.jsonl",
    )
    expect(writeStateTextMock).toHaveBeenCalledWith(
      config,
      tmp,
      "events/s1.jsonl",
      '{"type":"message"}\n',
      "chat: persist both",
      "sha-events/s1.jsonl",
    )
  })
})
