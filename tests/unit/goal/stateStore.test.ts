import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { fetchGoalState, putGoalState } from "../../../src/goal/stateStore.js"
import { gh } from "../../../src/issue.js"

const config = {
  state: { repo: "acme/kody-state", path: "widgets" },
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("goal state store", () => {
  it("returns null when state file is missing", () => {
    vi.mocked(gh).mockImplementation(() => {
      throw new Error("HTTP 404 Not Found")
    })

    expect(fetchGoalState(config, "release")).toBeNull()
  })

  it("reads and decodes goal state from the configured state repo", () => {
    vi.mocked(gh).mockReturnValue(
      JSON.stringify({
        sha: "abc",
        type: "file",
        encoding: "base64",
        content: b64(
          JSON.stringify({
            state: "active",
            type: "release",
            destination: { outcome: "ship", evidence: ["published"] },
            capabilities: ["release"],
            route: [],
            facts: {},
            blockers: [],
          }),
        ),
      }),
    )

    const state = fetchGoalState(config, "release")

    expect(state?.state).toBe("active")
    expect(state?.extra.type).toBe("release")
    expect(vi.mocked(gh).mock.calls[0]?.[0]).toEqual([
      "api",
      "/repos/acme/kody-state/contents/widgets/goals/instances/release/state.json",
    ])
  })

  it("writes goal state with current file sha", () => {
    vi.mocked(gh).mockImplementation((args, _opts) => {
      const apiPath = args.find(
        (arg) => arg === "/repos/acme/kody-state/contents/widgets/goals/instances/release/state.json",
      )
      if (apiPath) {
        if (args.includes("--method")) return ""
        return JSON.stringify({ sha: "old", type: "file", encoding: "base64", content: b64("{}") })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    putGoalState(config, "release", { state: "done", extra: { type: "release" } }, "update goal", "/tmp/repo")

    expect(vi.mocked(gh).mock.calls.at(-1)?.[0]).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/acme/kody-state/contents/widgets/goals/instances/release/state.json",
      "--input",
      "-",
    ])
  })
})
