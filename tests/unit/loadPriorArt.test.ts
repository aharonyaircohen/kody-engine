import { describe, expect, it } from "vitest"
import { loadPriorArt } from "../../src/scripts/loadPriorArt.js"
import type { Context, Profile } from "../../src/executables/types.js"
import type { TaskState } from "../../src/state.js"

function makeCtx(taskState?: Partial<TaskState>): Context {
  return {
    args: { issue: 1 },
    cwd: "/tmp/nonexistent-" + Date.now(),
    config: {
      quality: { typecheck: "", lint: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "o", repo: "r" },
      agent: { model: "claude/haiku" },
    } as unknown as Context["config"],
    data: taskState ? { taskState } : {},
    output: { exitCode: 0 },
  }
}

const dummyProfile = {} as Profile

describe("loadPriorArt", () => {
  it("sets priorArt to empty string when artifact is missing", async () => {
    const ctx = makeCtx({ artifacts: {} } as Partial<TaskState>)
    await loadPriorArt(ctx, dummyProfile, {})
    expect(ctx.data.priorArt).toBe("")
  })

  it("sets priorArt to empty string when task state is absent", async () => {
    const ctx = makeCtx()
    await loadPriorArt(ctx, dummyProfile, {})
    expect(ctx.data.priorArt).toBe("")
  })

  it("sets priorArt to empty string when PR list is empty JSON array", async () => {
    const ctx = makeCtx({
      artifacts: {
        priorArt: { format: "json", producedBy: "research", createdAt: "", content: "[]" },
      },
    } as Partial<TaskState>)
    await loadPriorArt(ctx, dummyProfile, {})
    expect(ctx.data.priorArt).toBe("")
  })

  it("ignores invalid JSON content without throwing", async () => {
    const ctx = makeCtx({
      artifacts: {
        priorArt: { format: "json", producedBy: "research", createdAt: "", content: "not-json-{" },
      },
    } as Partial<TaskState>)
    await loadPriorArt(ctx, dummyProfile, {})
    expect(ctx.data.priorArt).toBe("")
  })

  it("ignores non-array JSON without throwing", async () => {
    const ctx = makeCtx({
      artifacts: {
        priorArt: { format: "json", producedBy: "research", createdAt: "", content: '{"foo": 1}' },
      },
    } as Partial<TaskState>)
    await loadPriorArt(ctx, dummyProfile, {})
    expect(ctx.data.priorArt).toBe("")
  })

  it("filters non-integer entries from the array", async () => {
    // Empty filtered list → empty block (no gh call made).
    const ctx = makeCtx({
      artifacts: {
        priorArt: {
          format: "json",
          producedBy: "research",
          createdAt: "",
          content: '["abc", 0, -1, null]',
        },
      },
    } as Partial<TaskState>)
    await loadPriorArt(ctx, dummyProfile, {})
    expect(ctx.data.priorArt).toBe("")
  })

  it("honours the artifactName override", async () => {
    const ctx = makeCtx({
      artifacts: {
        customKey: { format: "json", producedBy: "research", createdAt: "", content: "[]" },
      },
    } as Partial<TaskState>)
    await loadPriorArt(ctx, dummyProfile, { artifactName: "customKey" })
    expect(ctx.data.priorArt).toBe("")
  })
})
