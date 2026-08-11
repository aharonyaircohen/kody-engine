import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  FileBrainTerminalMetadataStore,
  TmuxBrainTerminalRuntime,
  type RunTerminalCommand,
} from "../../src/terminal/brain-terminal-adapters.js"
import type { StoredBrainTerminalSession } from "../../src/terminal/brain-terminal-session.js"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function session(id = "terminal/../../safe-by-hash"): StoredBrainTerminalSession {
  return {
    version: 1,
    id,
    scope: { owner: "acme", repo: "widgets", conversationId: "conversation-1" },
    sessionName: "kody_hash",
    cwd: "/workspace/repos/acme/widgets",
    generation: 1,
    state: "ready",
    revision: 0,
    output: "",
    processId: 42,
    cols: 120,
    rows: 36,
    updatedAt: "2026-08-11T00:00:00.000Z",
  }
}

describe("FileBrainTerminalMetadataStore", () => {
  it("stores metadata atomically under a hashed filename", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kody-terminal-store-"))
    temporaryRoots.push(root)
    const store = new FileBrainTerminalMetadataStore(root)
    const value = session()

    await store.write(value)

    expect(await store.read(value.id)).toEqual(value)
    const files = await fs.readdir(root)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/)
  })
})

describe("TmuxBrainTerminalRuntime", () => {
  it("starts a shell in the repository and reports the pane process", async () => {
    const run = vi.fn<RunTerminalCommand>(async (_command, args) => {
      if (args[0] === "list-panes") return { code: 0, stdout: "0:4242\n", stderr: "" }
      return { code: 0, stdout: "", stderr: "" }
    })
    const runtime = new TmuxBrainTerminalRuntime(run)

    await expect(runtime.start("kody_session", "/workspace/repos/acme/widgets", 120, 36)).resolves.toEqual({
      processId: 4242,
    })
    expect(run).toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["new-session", "-s", "kody_session", "-c", "/workspace/repos/acme/widgets"]),
      undefined,
    )
  })

  it("captures the active alternate screen", async () => {
    const run = vi.fn<RunTerminalCommand>(async (_command, args) => {
      if (args[0] === "display-message") return { code: 0, stdout: "1\n", stderr: "" }
      return { code: 0, stdout: "codex screen", stderr: "" }
    })
    const runtime = new TmuxBrainTerminalRuntime(run)

    expect(await runtime.capture("kody_session")).toBe("codex screen")
    expect(run).toHaveBeenLastCalledWith(
      "tmux",
      ["capture-pane", "-p", "-e", "-t", "kody_session"],
      undefined,
    )
  })

  it("writes input through a temporary tmux buffer without shell interpolation", async () => {
    const run = vi.fn<RunTerminalCommand>(async () => ({ code: 0, stdout: "", stderr: "" }))
    const runtime = new TmuxBrainTerminalRuntime(run)

    await runtime.input("kody_session", "$(touch /tmp/nope)\r")

    expect(run.mock.calls[0]?.[1].slice(0, 2)).toEqual(["load-buffer", "-b"])
    expect(run.mock.calls[0]?.[2]).toBe("$(touch /tmp/nope)\r")
    expect(run.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["paste-buffer", "-d", "-t", "kody_session"]),
    )
  })
})
