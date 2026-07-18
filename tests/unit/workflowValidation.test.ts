import { describe, expect, it } from "vitest"
import { validateWorkflow } from "../../src/workflowValidation.js"

function codes(workflow: unknown): string[] {
  return validateWorkflow(workflow).map((issue) => issue.code)
}

describe("validateWorkflow", () => {
  it("accepts a linear workflow and a complete branching loop", () => {
    expect(validateWorkflow({ steps: [{ capability: "inspect" }, { capability: "publish" }] })).toEqual([])
    expect(
      validateWorkflow({
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "inspect",
            next: [
              { to: "repair", when: { "facts.needsFix": true } },
              { to: "publish", default: true },
            ],
          },
          { id: "repair", capability: "repair", next: [{ to: "inspect", maxIterations: 3 }] },
          { id: "publish", capability: "publish" },
        ],
      }),
    ).toEqual([])
  })

  it("accepts only structured result fields declared by the source capability", () => {
    const capabilityOutputs = new Map([["inspect", new Set(["result.status", "result.facts.needsFix"])]] as const)
    expect(
      validateWorkflow(
        {
          startAt: "inspect",
          steps: [
            {
              id: "inspect",
              capability: "inspect",
              next: [
                { to: "repair", when: { "result.facts.needsFix": true } },
                { to: "finish", default: true },
              ],
            },
            { id: "repair", capability: "repair" },
            { id: "finish", capability: "finish" },
          ],
        },
        { capabilityOutputs },
      ),
    ).toEqual([])
  })

  it("rejects a condition that reads an undeclared result field", () => {
    const issues = validateWorkflow(
      {
        startAt: "inspect",
        steps: [
          {
            id: "inspect",
            capability: "inspect",
            next: [
              { to: "repair", when: { "result.facts.needsFix": true } },
              { to: "finish", default: true },
            ],
          },
          { id: "repair", capability: "repair" },
          { id: "finish", capability: "finish" },
        ],
      },
      { capabilityOutputs: new Map([["inspect", new Set(["result.status"])]] as const) },
    )

    expect(issues).toEqual([
      expect.objectContaining({ code: "undeclared_result_path", path: "steps[0].next[0].when.result.facts.needsFix" }),
    ])
  })

  it("accepts documented camelCase step ids in graph workflows", () => {
    expect(
      validateWorkflow({
        startAt: "healthCheck",
        steps: [
          { id: "healthCheck", capability: "inspect", next: "finish" },
          { id: "finish", capability: "publish" },
        ],
      }),
    ).toEqual([])
  })

  it("accepts camelCase targets for bounded graph loops", () => {
    expect(
      validateWorkflow({
        startAt: "healthCheck",
        steps: [
          { id: "healthCheck", capability: "inspect", next: "repair" },
          {
            id: "repair",
            capability: "inspect",
            next: [
              { to: "healthCheck", maxIterations: 1 },
              { to: "finish", default: true },
            ],
          },
          { id: "finish", capability: "publish" },
        ],
      }),
    ).toEqual([])
  })

  it.each([
    [{}, "steps_required"],
    [{ steps: [] }, "steps_required"],
    [
      {
        steps: [
          { id: "inspect", capability: "inspect" },
          { id: "inspect", capability: "publish" },
        ],
      },
      "duplicate_step_id",
    ],
    [{ startAt: "missing", steps: [{ id: "inspect", capability: "inspect" }] }, "missing_start_step"],
    [{ steps: [{ id: "inspect", capability: "inspect", next: "missing" }] }, "missing_transition_target"],
    [
      {
        steps: [
          { id: "inspect", capability: "inspect", next: "publish" },
          { id: "orphan", capability: "repair" },
          { id: "publish", capability: "publish" },
        ],
      },
      "unreachable_step",
    ],
    [
      {
        steps: [
          { id: "inspect", capability: "inspect", next: [{ to: "repair", when: { "facts.needsFix": true } }] },
          { id: "repair", capability: "repair" },
        ],
      },
      "missing_default_transition",
    ],
    [
      {
        steps: [
          { id: "inspect", capability: "inspect", next: "repair" },
          { id: "repair", capability: "repair", next: "inspect" },
        ],
      },
      "unbounded_loop",
    ],
    [
      {
        steps: [
          {
            id: "inspect",
            capability: "inspect",
            next: [
              { to: "publish", when: { "secret.value": true } },
              { to: "publish", default: true },
            ],
          },
          { id: "publish", capability: "publish" },
        ],
      },
      "invalid_data_path",
    ],
    [
      {
        steps: [{ id: "inspect", capability: "inspect", inputs: { prompt: { from: "unknown.value" } } }],
      },
      "invalid_data_path",
    ],
  ] as const)("rejects invalid agent output %#", (workflow, expectedCode) => {
    expect(codes(workflow)).toContain(expectedCode)
  })

  it("rejects unknown capabilities and unsupported mapped inputs when contracts are supplied", () => {
    const workflow = {
      steps: [
        {
          id: "inspect",
          capability: "missing",
          inputs: { unexpected: { from: "facts.value" } },
        },
      ],
    }
    const issues = validateWorkflow(workflow, {
      knownCapabilities: new Set(["inspect"]),
      capabilityInputs: new Map([["missing", new Set(["prompt"])]]),
    })

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unknown_capability", "unknown_capability_input"]),
    )
  })

  it("rejects invented workflow fields instead of silently ignoring them", () => {
    const issues = validateWorkflow({
      steps: [
        {
          id: "inspect",
          capability: "inspect",
          produces: ["health"],
          next: [{ to: "publish", default: true, handoff: "health" }],
        },
        { id: "publish", capability: "publish" },
      ],
    })

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unsupported_step_field", "unsupported_transition_field"]),
    )
  })
})
