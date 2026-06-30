import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/issue.js", () => ({
  gh: vi.fn(),
}))

import { fetchGoalState, listGoalStateIds, putGoalState } from "../../../src/goal/stateStore.js"
import { gh } from "../../../src/issue.js"
import { STATE_BRANCH } from "../../../src/stateBranch.js"

const config = {
  state: { repo: "acme/kody-state", path: "widgets" },
}

function b64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64")
}

function todoJson(title: string, state = "active"): string {
  return `${JSON.stringify(
    {
      version: 1,
      title,
      id: title,
      description: "ship",
      managed: true,
      managedModel: "agentGoal",
      state,
      type: "release",
      destination: { outcome: "ship", evidence: ["published"] },
      evidence: ["published"],
      capabilities: ["release"],
      route: [],
      facts: {},
      blockers: [],
      items: [
        {
          id: "published",
          title: "published",
          body: "keep user notes",
          assignee: null,
          completed: state === "done",
          createdAt: "2026-06-28T00:00:00.000Z",
          completedAt: null,
          meta: { evidence: "published" },
        },
      ],
    },
    null,
    2,
  )}\n`
}

function regularTodoJson(title: string): string {
  return `${JSON.stringify(
    {
      version: 1,
      title,
      description: "",
      createdAt: "2026-06-28T00:00:00.000Z",
      items: [
        {
          id: "item-1",
          title: "regular todo",
          body: "",
          assignee: null,
          completed: false,
          createdAt: "2026-06-28T00:00:00.000Z",
          completedAt: null,
        },
      ],
    },
    null,
    2,
  )}\n`
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

  it("reads and decodes goal state from the todo JSON file in the configured state repo", () => {
    vi.mocked(gh).mockReturnValue(
      JSON.stringify({
        sha: "abc",
        type: "file",
        encoding: "base64",
        content: b64(todoJson("release")),
      }),
    )

    const state = fetchGoalState(config, "release")

    expect(state?.state).toBe("active")
    expect(state?.extra.type).toBe("release")
    expect(state?.extra.destination).toMatchObject({
      outcome: "ship",
      evidence: ["published"],
    })
    expect(vi.mocked(gh).mock.calls[0]?.[0]).toEqual([
      "api",
      `/repos/acme/kody-state/contents/widgets/todos/release.json?ref=${STATE_BRANCH}`,
    ])
  })

  it("ignores regular todo files instead of treating them as goals", () => {
    vi.mocked(gh).mockImplementation((args) => {
      const command = args.join(" ")
      if (command === `api /repos/acme/kody-state/contents/widgets/todos/todo-list-1.json?ref=${STATE_BRANCH}`) {
        return JSON.stringify({
          sha: "todo-sha",
          type: "file",
          encoding: "base64",
          content: b64(regularTodoJson("todo-list-1")),
        })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    expect(fetchGoalState(config, "todo-list-1")).toBeNull()
    expect(vi.mocked(gh)).toHaveBeenCalledTimes(1)
  })

  it("does not list regular todo files as goal state ids", () => {
    vi.mocked(gh).mockImplementation((args) => {
      const command = args.join(" ")
      if (command === `api /repos/acme/kody-state/contents/widgets/todos?ref=${STATE_BRANCH}`) {
        return JSON.stringify([
          { name: "release.json", type: "file" },
          { name: "todo-list-1.json", type: "file" },
        ])
      }
      if (command === `api /repos/acme/kody-state/contents/widgets/todos/release.json?ref=${STATE_BRANCH}`) {
        return JSON.stringify({ sha: "sha", type: "file", encoding: "base64", content: b64(todoJson("release")) })
      }
      if (command === `api /repos/acme/kody-state/contents/widgets/todos/todo-list-1.json?ref=${STATE_BRANCH}`) {
        return JSON.stringify({
          sha: "sha",
          type: "file",
          encoding: "base64",
          content: b64(regularTodoJson("todo-list-1")),
        })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    expect(listGoalStateIds(config)).toEqual(["release"])
  })

  it("does not overwrite regular todo files when writing goal state", () => {
    vi.mocked(gh).mockImplementation((args) => {
      const command = args.join(" ")
      if (command === `api /repos/acme/kody-state/contents/widgets/todos/todo-list-1.json?ref=${STATE_BRANCH}`) {
        return JSON.stringify({
          sha: "todo-sha",
          type: "file",
          encoding: "base64",
          content: b64(regularTodoJson("todo-list-1")),
        })
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    expect(() =>
      putGoalState(
        config,
        "todo-list-1",
        {
          state: "done",
          extra: {
            type: "release",
            destination: { outcome: "ship", evidence: ["published"] },
            capabilities: ["release"],
            route: [],
            facts: { published: true },
            blockers: [],
          },
        },
        "update goal",
        "/tmp/repo",
      ),
    ).toThrow("Cannot overwrite regular todo list todo-list-1")
  })

  it("writes goal state with current file sha", () => {
    vi.mocked(gh).mockImplementation((args, opts) => {
      const command = args.join(" ")
      if (command === `api /repos/acme/kody-state/git/ref/heads/${STATE_BRANCH}`) {
        return JSON.stringify({ object: { sha: "state-branch-sha" } })
      }
      if (command === `api /repos/acme/kody-state/contents/widgets/todos/release.json?ref=${STATE_BRANCH}`) {
        return JSON.stringify({ sha: "old", type: "file", encoding: "base64", content: b64(todoJson("release")) })
      }
      if (command === "api --method PUT /repos/acme/kody-state/contents/widgets/todos/release.json --input -") {
        const payload = JSON.parse(String(opts?.input ?? "{}")) as Record<string, unknown>
        expect(payload.branch).toBe(STATE_BRANCH)
        expect(payload.sha).toBe("old")
        const content = Buffer.from(String(payload.content), "base64").toString("utf8")
        const parsed = JSON.parse(content) as Record<string, unknown>
        expect(parsed.items).toMatchObject([{ id: "published", body: "keep user notes" }])
        return ""
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`)
    })

    putGoalState(
      config,
      "release",
      {
        state: "done",
        extra: {
          type: "release",
          destination: { outcome: "ship", evidence: ["published"] },
          capabilities: ["release"],
          route: [],
          facts: { published: true },
          blockers: [],
        },
      },
      "update goal",
      "/tmp/repo",
    )

    expect(vi.mocked(gh).mock.calls.at(-1)?.[0]).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/acme/kody-state/contents/widgets/todos/release.json",
      "--input",
      "-",
    ])
  })
})
