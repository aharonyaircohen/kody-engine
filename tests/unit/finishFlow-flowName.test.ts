import { beforeEach, describe, expect, it, vi } from "vitest"

const execFileSyncSpy = vi.fn().mockReturnValue("")
vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    execFileSync: (cmd: string, args: string[], opts: unknown) => execFileSyncSpy(cmd, args, opts),
  }
})

import type { Context, Profile } from "../../src/agent-actions/types.js"
import { finishFlow } from "../../src/scripts/finishFlow.js"

function makeCtx(taskState: unknown): Context {
  return {
    args: { issue: 42 },
    cwd: "/tmp",
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    config: {} as any,
    data: { taskState },
    output: { exitCode: 0 },
  }
}

function makeProfile(name: string): Profile {
  // biome-ignore lint/suspicious/noExplicitAny: only `name` is consulted
  return { name } as any
}

describe("finishFlow: flow name resolution", () => {
  beforeEach(() => execFileSyncSpy.mockClear())

  it("uses state.flow.name when seeded by startFlow", async () => {
    const state = { flow: { name: "feature", step: "run", issueNumber: 42, startedAt: "x" }, core: {} }
    await finishFlow(makeCtx(state), makeProfile("feature"), null, { reason: "review-passed" })
    const callArgs = execFileSyncSpy.mock.calls[0]?.[1] as string[]
    expect(callArgs.join(" ")).toContain("kody flow `feature` finished")
  })

  it("falls back to profile.name when state.flow is missing (container-driven flow)", async () => {
    const state = { core: {} }
    await finishFlow(makeCtx(state), makeProfile("bug"), null, { reason: "fix-applied" })
    const callArgs = execFileSyncSpy.mock.calls[0]?.[1] as string[]
    expect(callArgs.join(" ")).toContain("kody flow `bug` finished")
    expect(callArgs.join(" ")).not.toContain("(unknown flow)")
  })

  it("falls back to placeholder only when neither state.flow nor profile.name is available", async () => {
    const state = { core: {} }
    // biome-ignore lint/suspicious/noExplicitAny: deliberately blank
    await finishFlow(makeCtx(state), { name: "" } as any, null, { reason: "aborted" })
    const callArgs = execFileSyncSpy.mock.calls[0]?.[1] as string[]
    expect(callArgs.join(" ")).toContain("(unknown flow)")
  })
})
