import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StateEnvelope } from "../../src/scripts/issueStateComment.js"

const backend = {
  get: vi.fn(),
  save: vi.fn(),
}

vi.mock("../../src/state-backend.js", () => ({
  createStateBackendFromEnv: () => backend,
}))

import { BackendStateBackend } from "../../src/scripts/jobState/backendStateBackend.js"

function envelope(overrides: Partial<StateEnvelope> = {}): StateEnvelope {
  return {
    version: 1,
    rev: 1,
    cursor: "tick-1",
    data: { foo: "bar" },
    done: false,
    ...overrides,
  }
}

function createBackend(): BackendStateBackend {
  return new BackendStateBackend({
    config: {
      quality: { typecheck: "", lint: "", format: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "acme", repo: "widgets" },
      agent: { model: "anthropic/test" },
    },
    jobsDir: ".kody-engine/definitions/capabilities",
  })
}

describe("BackendStateBackend", () => {
  beforeEach(() => {
    backend.get.mockReset()
    backend.save.mockReset()
  })

  it("requires a tenant", () => {
    expect(
      () =>
        new BackendStateBackend({
          config: {
            quality: { typecheck: "", lint: "", format: "", testUnit: "" },
            git: { defaultBranch: "main" },
            github: { owner: "", repo: "" },
            agent: { model: "anthropic/test" },
          },
          jobsDir: "x",
        }),
    ).toThrow(/github.owner.*github.repo/i)
  })

  it("returns a seed when state does not exist", async () => {
    backend.get.mockResolvedValue(null)
    const loaded = await createBackend().load("auto-sync")
    expect(loaded).toMatchObject({ created: true, handle: null })
    expect(loaded.state).toMatchObject({ rev: 0, cursor: "seed" })
  })

  it("loads an existing state with its concurrency token", async () => {
    const state = envelope({ rev: 5 })
    backend.get.mockResolvedValue({ doc: state, updatedAt: "2026-07-18T00:00:00Z" })
    const loaded = await createBackend().load("auto-sync")
    expect(loaded).toMatchObject({ created: false, handle: "2026-07-18T00:00:00Z", state })
  })

  it("rejects invalid persisted state", async () => {
    backend.get.mockResolvedValue({ doc: { invalid: true }, updatedAt: "now" })
    await expect(createBackend().load("auto-sync")).rejects.toThrow(/StateEnvelope/)
  })

  it("saves changed state with optimistic concurrency", async () => {
    backend.save.mockResolvedValue(undefined)
    const next = envelope({ cursor: "after" })
    const wrote = await createBackend().save(
      {
        path: ".kody-engine/definitions/capabilities/auto-sync/state.json",
        handle: "old",
        state: envelope(),
        created: false,
      },
      next,
    )
    expect(wrote).toBe(true)
    expect(backend.save).toHaveBeenCalledWith("acme/widgets", "capabilities/auto-sync", "job-state", next, "old")
  })

  it("skips structurally unchanged state", async () => {
    const previous = envelope({ rev: 1 })
    const next = envelope({ rev: 2 })
    expect(
      await createBackend().save(
        {
          path: ".kody-engine/definitions/capabilities/auto-sync/state.json",
          handle: "old",
          state: previous,
          created: false,
        },
        next,
      ),
    ).toBe(false)
    expect(backend.save).not.toHaveBeenCalled()
  })
})
