import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

vi.mock("../../../src/stateBranch.js", () => ({
  STATE_BRANCH: "kody-state",
  ensureStateBranch: vi.fn(),
}))

import { fetchGoalState, putGoalState } from "../../../src/goal/stateStore.js"
import { gh } from "../../../src/issue.js"
import { ensureStateBranch } from "../../../src/stateBranch.js"

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("goal state store", () => {
  it("returns null when the state file is missing", () => {
    vi.mocked(gh).mockImplementation(() => {
      throw new Error("HTTP 404 Not Found")
    })

    expect(fetchGoalState("acme", "widgets", "release")).toBeNull()
  })

  it("reads and decodes goal state from kody-state", () => {
    vi.mocked(gh).mockReturnValue(
      JSON.stringify({
        content: b64(
          JSON.stringify({
            state: "active",
            type: "release",
            destination: { outcome: "ship", evidence: ["published"] },
            agentResponsibilities: ["release"],
            route: [],
            facts: {},
            blockers: [],
          }),
        ),
      }),
    )

    const state = fetchGoalState("acme", "widgets", "release")

    expect(state?.state).toBe("active")
    expect(state?.extra.type).toBe("release")
    expect(vi.mocked(gh).mock.calls[0]?.[0]).toEqual([
      "api",
      "/repos/acme/widgets/contents/.kody/goals/instances/release/state.json?ref=kody-state",
    ])
  })

  it("writes goal state with the current file sha", () => {
    vi.mocked(gh).mockImplementation((args, opts) => {
      if (args[1] === "/repos/acme/widgets/contents/.kody/goals/instances/release/state.json?ref=kody-state") {
        return JSON.stringify({ sha: "abc123" })
      }
      if (args[1] === "--method") {
        expect(JSON.parse(String(opts?.input))).toMatchObject({
          message: "update goal",
          branch: "kody-state",
          sha: "abc123",
        })
        return JSON.stringify({ ok: true })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    putGoalState(
      "acme",
      "widgets",
      "release",
      { state: "done", extra: { type: "release" } },
      "update goal",
      "/tmp/repo",
    )

    expect(ensureStateBranch).toHaveBeenCalledWith("acme", "widgets", "/tmp/repo")
    expect(vi.mocked(gh).mock.calls.at(-1)?.[0]).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/acme/widgets/contents/.kody/goals/instances/release/state.json",
      "--input",
      "-",
    ])
  })
})
