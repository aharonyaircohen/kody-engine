import { describe, expect, it } from "vitest"
import {
  type BrainTerminalMetadataStore,
  type BrainTerminalRuntime,
  BrainTerminalSessionAgent,
  type StoredBrainTerminalSession,
} from "../../src/terminal/brain-terminal-session.js"

class MemoryStore implements BrainTerminalMetadataStore {
  private readonly sessions = new Map<string, StoredBrainTerminalSession>()

  async read(id: string): Promise<StoredBrainTerminalSession | null> {
    return this.sessions.get(id) ?? null
  }

  async write(session: StoredBrainTerminalSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session))
  }
}

class FakeRuntime implements BrainTerminalRuntime {
  alive = false
  pid = 0
  output = ""
  inputs: string[] = []
  sizes: Array<{ cols: number; rows: number }> = []
  startError: Error | null = null

  async start(): Promise<{ processId: number }> {
    if (this.startError) throw this.startError
    this.alive = true
    this.pid += 1
    return { processId: this.pid }
  }

  async inspect(): Promise<{ alive: boolean; processId: number | null }> {
    return { alive: this.alive, processId: this.alive ? this.pid : null }
  }

  async capture(): Promise<string> {
    return this.output
  }

  async input(_sessionName: string, data: string): Promise<void> {
    this.inputs.push(data)
  }

  async resize(_sessionName: string, cols: number, rows: number): Promise<void> {
    this.sizes.push({ cols, rows })
  }

  async stop(): Promise<void> {
    this.alive = false
  }
}

const open = {
  type: "open" as const,
  session: {
    id: "terminal-1",
    scope: {
      owner: "acme",
      repo: "widgets",
      conversationId: "conversation-1",
    },
  },
  cwd: "/workspace/repos/acme/widgets",
  cols: 120,
  rows: 36,
}

describe("BrainTerminalSessionAgent", () => {
  it("creates one durable generation and reattaches to the same process", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    const first = new BrainTerminalSessionAgent({ store, runtime })

    const firstEvents = await first.open(open)
    const firstStatus = await first.status()
    await first.detach()

    const second = new BrainTerminalSessionAgent({ store, runtime })
    const secondEvents = await second.open(open)
    const secondStatus = await second.status()

    expect(firstEvents).toContainEqual(expect.objectContaining({ type: "state", state: "ready", generation: 1 }))
    expect(secondEvents).toContainEqual(expect.objectContaining({ type: "state", state: "ready", generation: 1 }))
    expect(secondStatus).toMatchObject({ generation: 1, processId: firstStatus.processId })
  })

  it("replays the current screen only when the client revision is stale", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    runtime.output = "screen one"
    const agent = new BrainTerminalSessionAgent({ store, runtime })

    await agent.open(open)
    const output = await agent.captureOutput()
    expect(output).toMatchObject({ type: "output", generation: 1, revision: 1 })

    await agent.detach()
    const current = new BrainTerminalSessionAgent({ store, runtime })
    const currentEvents = await current.open({ ...open, afterRevision: 1 })
    const staleEvents = await new BrainTerminalSessionAgent({ store, runtime }).open({
      ...open,
      afterRevision: 0,
    })

    expect(currentEvents.some((event) => event.type === "output")).toBe(false)
    expect(staleEvents).toContainEqual(
      expect.objectContaining({ type: "output", revision: 1, data: expect.stringContaining("screen one") }),
    )
  })

  it("acknowledges input only after the runtime accepts it", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    const agent = new BrainTerminalSessionAgent({ store, runtime })
    await agent.open(open)

    const event = await agent.command({
      type: "input",
      sessionId: open.session.id,
      inputId: "input-1",
      data: "codex\r",
    })

    expect(runtime.inputs).toEqual(["codex\r"])
    expect(event).toEqual(expect.objectContaining({ type: "input-accepted", inputId: "input-1", generation: 1 }))
  })

  it("resizes and detaches without replacing the process", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    const agent = new BrainTerminalSessionAgent({ store, runtime })
    await agent.open(open)
    const processId = (await agent.status()).processId

    await agent.command({ type: "resize", sessionId: open.session.id, cols: 90, rows: 28 })
    await agent.command({ type: "detach", sessionId: open.session.id })

    expect(runtime.sizes.at(-1)).toEqual({ cols: 90, rows: 28 })
    expect(await runtime.inspect()).toEqual({ alive: true, processId })
  })

  it("uses restart as the only operation that changes generation and process", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    const agent = new BrainTerminalSessionAgent({ store, runtime })
    await agent.open(open)
    const before = await agent.status()

    const event = await agent.command({ type: "restart", sessionId: open.session.id })
    const after = await agent.status()

    expect(event).toMatchObject({ type: "state", state: "ready", generation: 2 })
    expect(after.generation).toBe(2)
    expect(after.processId).not.toBe(before.processId)
  })

  it("rejects another session identity and invalid commands", async () => {
    const agent = new BrainTerminalSessionAgent({ store: new MemoryStore(), runtime: new FakeRuntime() })
    await agent.open(open)

    await expect(agent.command({ type: "detach", sessionId: "another-session" })).rejects.toThrow("session identity")
    await expect(agent.command({ type: "input", sessionId: open.session.id, inputId: "", data: "x" })).rejects.toThrow(
      "inputId",
    )
  })

  it("inspects stored state without creating a missing session", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    const agent = new BrainTerminalSessionAgent({ store, runtime })

    expect(await agent.inspectStored("missing")).toBeNull()
    expect(runtime.pid).toBe(0)

    await agent.open(open)
    await agent.detach()
    expect(await new BrainTerminalSessionAgent({ store, runtime }).inspectStored(open.session.id)).toMatchObject({
      id: open.session.id,
      generation: 1,
      processId: 1,
    })
  })

  it("persists startup failure and waits for an explicit restart", async () => {
    const store = new MemoryStore()
    const runtime = new FakeRuntime()
    runtime.startError = new Error("tmux unavailable")
    const agent = new BrainTerminalSessionAgent({ store, runtime })

    await expect(agent.open(open)).resolves.toContainEqual(
      expect.objectContaining({
        type: "failed",
        generation: 1,
        code: "runtime_start_failed",
        message: "tmux unavailable",
      }),
    )
    expect(await agent.status()).toMatchObject({ state: "failed", generation: 1 })

    runtime.startError = null
    await expect(agent.command({ type: "restart", sessionId: open.session.id })).resolves.toMatchObject({
      type: "state",
      state: "ready",
      generation: 2,
    })
  })
})
