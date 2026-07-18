import { afterEach, describe, expect, it, vi } from "vitest"

import { isManagedTodoRaw, parseTodoGoalState, serializeTodoGoalState } from "../../../src/goal/managedTodoState.js"

afterEach(() => {
  vi.useRealTimers()
})

describe("managed todo goal state", () => {
  it("parses todo items into the canonical goal contract", () => {
    const state = parseTodoGoalState(
      "ship-release",
      "todos/ship-release.json",
      JSON.stringify({
        managed: true,
        description: "Ship the release",
        items: [
          {
            id: "tests-green",
            title: "Run tests",
            completed: true,
            meta: { evidence: "tests-green", stage: "verify", capability: "wait-ci" },
          },
        ],
      }),
    )

    expect(state.state).toBe("active")
    expect(state.extra.id).toBe("ship-release")
    expect(state.extra.destination).toEqual({
      outcome: "Ship the release",
      evidence: ["tests-green"],
    })
    expect(state.extra.capabilities).toEqual(["wait-ci"])
    expect(state.extra.facts).toEqual({ "tests-green": true })
  })

  it("serializes canonical evidence while preserving operator-authored todo fields", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"))

    const result = JSON.parse(
      serializeTodoGoalState(
        "ship-release",
        {
          state: "active",
          createdAt: "2026-07-17T10:00:00.000Z",
          extra: {
            destination: { outcome: "Ship the release", evidence: ["tests-green"] },
            route: [{ evidence: "tests-green", stage: "verify", capability: "wait-ci" }],
            facts: { "tests-green": true },
            evidenceState: { "tests-green": { attempts: 2, resultClass: "success" } },
          },
        },
        JSON.stringify({
          items: [
            {
              id: "tests-green",
              title: "Keep this title",
              body: "Keep this note",
              assignee: "qa",
              completed: false,
              createdAt: "2026-07-17T11:00:00.000Z",
              completedAt: null,
            },
          ],
        }),
      ),
    ) as Record<string, unknown>

    expect(result).toMatchObject({
      id: "ship-release",
      managed: true,
      managedModel: "agentGoal",
      description: "Ship the release",
      evidence: ["tests-green"],
    })
    expect(result.items).toEqual([
      expect.objectContaining({
        id: "tests-green",
        title: "Keep this title",
        body: "Keep this note",
        assignee: "qa",
        completed: true,
        completedAt: "2026-07-18T12:00:00.000Z",
        meta: expect.objectContaining({
          capability: "wait-ci",
          attempts: 2,
          resultClass: "success",
        }),
      }),
    ])
  })

  it("recognizes only managed todo records", () => {
    expect(isManagedTodoRaw('{"managedModel":"agentLoop"}')).toBe(true)
    expect(isManagedTodoRaw('{"managed":true}')).toBe(true)
    expect(isManagedTodoRaw('{"managed":false}')).toBe(false)
    expect(isManagedTodoRaw("not json")).toBe(false)
  })
})
