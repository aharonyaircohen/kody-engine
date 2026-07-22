import type {
  IntentDefinition,
  LoopDefinition,
  OperationDefinition,
  Policy,
} from "@kody-ade/agency-domain"
import { describe, expect, it } from "vitest"
import type { AgencyDefinitionCatalog, DefinitionRecord } from "../../../src/goal/agencyModelRepository.js"
import { resolveDispatchPolicy } from "../../../src/goal/policyResolver.js"

const basePolicy: Policy = {
  approval: "none",
  authority: { allow: ["workflow:refresh-knowledge"], deny: [] },
  budget: { maxRuns: 10, maxTokens: 10000, maxCostUsd: 20, maxDurationSeconds: 600 },
  maxConcurrentRuns: 3,
  riskyActions: [],
}

describe("dispatch policy resolution", () => {
  it("merges inherited Intent policies using the strictest limits and pins its trace", () => {
    const catalog = makeCatalog([
      intent("quality", basePolicy),
      intent("safety", {
        ...basePolicy,
        budget: { ...basePolicy.budget, maxTokens: 5000 },
        maxConcurrentRuns: 1,
      }),
    ])

    const resolution = resolveDispatchPolicy({
      catalog,
      owner: loop(),
      target: { kind: "workflow", id: "refresh-knowledge", revision: "workflow-rev" },
    })

    expect(resolution.snapshot.policy).toMatchObject({
      budget: { maxTokens: 5000 },
      maxConcurrentRuns: 1,
    })
    expect(resolution.snapshot.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(resolution.trace).toEqual([
      { kind: "loop", id: "knowledge-loop", revision: "loop-rev" },
      { kind: "workflow", id: "refresh-knowledge", revision: "workflow-rev" },
    ])
  })

  it("blocks denied actions before dispatch", () => {
    const catalog = makeCatalog([
      intent("quality", { ...basePolicy, authority: { allow: ["*"], deny: ["refresh-knowledge"] } }),
    ])

    expect(() =>
      resolveDispatchPolicy({
        catalog,
        owner: loop(["quality"]),
        target: { kind: "workflow", id: "refresh-knowledge", revision: "workflow-rev" },
      }),
    ).toThrow(/authority denies/)
  })

  it("requires explicit approval for risky actions and matching constraints", () => {
    const catalog = makeCatalog([
      {
        ...intent("quality", { ...basePolicy, approval: "risky-actions", riskyActions: ["refresh-knowledge"] }),
        definition: {
          ...intent("quality", basePolicy).definition,
          policy: { ...basePolicy, approval: "risky-actions", riskyActions: ["refresh-knowledge"] },
          constraints: [
            {
              id: "review-refresh",
              rule: "A human must approve refreshes",
              actions: ["workflow:refresh-knowledge"],
              effect: "require-approval",
            },
          ],
        },
      },
    ])
    const input = {
      catalog,
      owner: loop(["quality"]),
      target: { kind: "workflow" as const, id: "refresh-knowledge", revision: "workflow-rev" },
    }

    const resolution = resolveDispatchPolicy(input)
    expect(resolution.requiresApproval).toBe(true)
    expect(resolution.snapshot.policy.approval).toBe("risky-actions")
  })
})

function intent(id: string, policy: Policy): DefinitionRecord<IntentDefinition> {
  return {
    revision: `${id}-rev`,
    definition: {
      id,
      direction: "Keep delivery trustworthy",
      priorities: ["evidence"],
      policy,
      constraints: [],
    },
  }
}

function loop(intentIds = ["quality", "safety"]): DefinitionRecord<LoopDefinition> {
  return {
    revision: "loop-rev",
    definition: {
      id: "knowledge-loop",
      operationId: "knowledge",
      objective: {
        desiredState: "Knowledge stays current",
        requiredEvidence: [],
        scope: { include: {}, exclude: {} },
      },
      trigger: { type: "schedule", every: "1h" },
      targetRef: { kind: "workflow", id: "refresh-knowledge" },
    reconciliationPolicy: { overlap: "skip", missed: "coalesce", failure: { maxAttempts: 3, backoffSeconds: 0, timeoutSeconds: 60 } },
    },
  }
}

function makeCatalog(intents: Array<DefinitionRecord<IntentDefinition>>): AgencyDefinitionCatalog {
  const operation: DefinitionRecord<OperationDefinition> = {
    revision: "operation-rev",
    definition: {
      id: "knowledge",
      name: "Knowledge",
      responsibility: "Keep knowledge current",
      intentIds: intents.map(({ definition }) => definition.id),
    },
  }
  return {
    intents: new Map(intents.map((record) => [record.definition.id, record])),
    operations: new Map([[operation.definition.id, operation]]),
    goals: new Map(),
    loops: new Map(),
    workflows: new Map(),
    capabilities: new Map(),
    agents: new Map(),
  }
}
