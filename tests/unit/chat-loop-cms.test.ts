import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatEvent, EventSink } from "../../src/chat/events.js"
import { runChatTurn } from "../../src/chat/loop.js"
import { appendTurn } from "../../src/chat/session.js"

const runAgentMock = vi.hoisted(() => vi.fn())

vi.mock("../../src/agent.js", () => ({
  runAgent: runAgentMock,
}))

class MemSink implements EventSink {
  events: ChatEvent[] = []
  async emit(e: ChatEvent): Promise<void> {
    this.events.push(e)
  }
}

const MODEL = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" }

describe("chat/loop Dashboard CMS wiring", () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kody-chat-loop-cms-"))
    runAgentMock.mockReset()
    runAgentMock.mockResolvedValue({
      outcome: "completed",
      finalText: "ok",
      ndjsonPath: path.join(tmp, "last-run.jsonl"),
    })
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("enables Dashboard CMS tools and tells the agent Dashboard is the source of truth", async () => {
    const sessionFile = path.join(tmp, "s.jsonl")
    appendTurn(sessionFile, { role: "user", content: "show course 6a408b5d4a2dd57df6b116ea", timestamp: "t1" })

    const res = await runChatTurn({
      sessionId: "s1",
      sessionFile,
      cwd: tmp,
      model: MODEL,
      litellmUrl: null,
      sink: new MemSink(),
      cmsDashboardUrl: "https://dashboard.example.test",
      cmsRepoSlug: "owner/repo",
      cmsToken: "test-token",
      cmsStoreRepoUrl: "https://github.com/acme/kody-store",
      cmsStoreRef: "stable",
    })

    expect(res.exitCode).toBe(0)
    const opts = runAgentMock.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.enableDashboardCmsTool).toBe(true)
    expect(opts.cmsDashboardUrl).toBe("https://dashboard.example.test")
    expect(opts.cmsRepoSlug).toBe("owner/repo")
    expect(opts.cmsToken).toBe("test-token")
    expect(opts.cmsStoreRepoUrl).toBe("https://github.com/acme/kody-store")
    expect(opts.cmsStoreRef).toBe("stable")
    expect(String(opts.systemPromptAppend)).toContain("Dashboard CMS tools")
    expect(String(opts.systemPromptAppend)).toContain("Dashboard is the source of truth")
  })
})
