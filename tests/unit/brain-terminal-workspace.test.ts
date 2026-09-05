import { Readable, Writable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ clone: vi.fn(), mkdir: vi.fn(), open: vi.fn() }))
vi.mock("../../src/repoWorkspace.js", () => ({ ensureRepoCwd: mocks.clone, defaultCloneRepo: vi.fn() }))
vi.mock("node:fs/promises", async (original) => ({ ...(await original<object>()), mkdir: mocks.mkdir }))
vi.mock("../../src/terminal/brain-terminal-session.js", async (original) => ({
  ...(await original<object>()),
  BrainTerminalSessionAgent: class {
    open = mocks.open
    detach = async () => {}
  },
}))
import { brainTerminalAgent } from "../../src/servers/brain-terminal-agent.js"
const open = {
  type: "open",
  session: { id: "personal-terminal", scope: { owner: "account-id", repo: "personal-brain", conversationId: "chat" } },
  cwd: "/client-supplied-path",
  cols: 80,
  rows: 24,
}
async function connect(workspace?: string) {
  return brainTerminalAgent({
    cwd: "/workspace/repo",
    input: Readable.from([JSON.stringify({ ...open, workspace }) + "\n"]),
    output: new Writable({
      write(_chunk, _encoding, done) {
        done()
      },
    }),
  })
}
describe("terminal workspace ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.open.mockResolvedValue([])
    mocks.clone.mockResolvedValue("/workspace/repos/account-id/personal-brain")
  })
  it("opens a personal machine directory without interpreting session scope as a GitHub repository", async () => {
    expect(await connect("machine")).toBe(0)
    expect(mocks.clone).not.toHaveBeenCalled()
    expect(mocks.mkdir).toHaveBeenCalledWith("/workspace/repo", { recursive: true })
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace/repo" }))
  })
  it("preserves repository workspace resolution for existing clients", async () => {
    expect(await connect()).toBe(0)
    expect(mocks.clone).toHaveBeenCalledWith(expect.objectContaining({ repo: "account-id/personal-brain" }))
  })
  it("rejects unknown workspace modes", async () => {
    expect(await connect("arbitrary")).toBe(1)
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
