import { createHash } from "node:crypto"
import type {
  Constraint,
  GoalDefinition,
  IntentDefinition,
  LoopDefinition,
  OperationDefinition,
  Policy,
  PinnedDefinitionRef,
} from "@kody-ade/agency-domain"
import type { AgencyDefinitionCatalog, DefinitionRecord } from "./agencyModelRepository.js"

export interface EffectivePolicySnapshot {
  hash: string
  policy: Policy
  constraints: Constraint[]
}

export interface DispatchPolicyResolution {
  snapshot: EffectivePolicySnapshot
  operation: DefinitionRecord<OperationDefinition>
  intents: Array<DefinitionRecord<IntentDefinition>>
  trace: PinnedDefinitionRef[]
  requiresApproval: boolean
}

export function resolveDispatchPolicy(input: {
  catalog: AgencyDefinitionCatalog
  owner: DefinitionRecord<GoalDefinition | LoopDefinition>
  target: PinnedDefinitionRef
}): DispatchPolicyResolution {
  const operation = input.catalog.operations.get(input.owner.definition.operationId)
  if (!operation) throw new Error(`Dispatch blocked: Operation "${input.owner.definition.operationId}" is unresolved`)
  if (operation.definition.intentIds.length === 0) {
    throw new Error(`Dispatch blocked: Operation "${operation.definition.id}" has no Intent`)
  }
  const intents = operation.definition.intentIds.map((intentId) => {
    const intent = input.catalog.intents.get(intentId)
    if (!intent) throw new Error(`Dispatch blocked: Intent "${intentId}" is unresolved`)
    return intent
  })
  const policy = mergePolicies(intents.map(({ definition }) => definition.policy))
  const constraints = intents.flatMap(({ definition }) => definition.constraints)
  const requiresApproval = assertAuthorized(policy, constraints, input.target)
  const snapshotValue = { policy, constraints }
  return {
    snapshot: {
      hash: createHash("sha256").update(stableJson(snapshotValue)).digest("hex"),
      ...snapshotValue,
    },
    operation,
    intents,
    trace: [
      pinned("trigger" in input.owner.definition ? "loop" : "goal", input.owner),
      input.target,
    ],
    requiresApproval,
  }
}

function mergePolicies(policies: readonly Policy[]): Policy {
  const approvalOrder = ["none", "risky-actions", "all-actions"] as const
  return {
    approval: policies.reduce<Policy["approval"]>(
      (strictest, policy) =>
        approvalOrder.indexOf(policy.approval) > approvalOrder.indexOf(strictest) ? policy.approval : strictest,
      "none",
    ),
    authority: {
      allow: intersect(policies.map(({ authority }) => authority.allow)),
      deny: unique(policies.flatMap(({ authority }) => authority.deny)),
    },
    budget: {
      maxRuns: Math.min(...policies.map(({ budget }) => budget.maxRuns)),
      maxTokens: Math.min(...policies.map(({ budget }) => budget.maxTokens)),
      maxCostUsd: Math.min(...policies.map(({ budget }) => budget.maxCostUsd)),
      maxDurationSeconds: Math.min(...policies.map(({ budget }) => budget.maxDurationSeconds)),
    },
    maxConcurrentRuns: Math.min(...policies.map(({ maxConcurrentRuns }) => maxConcurrentRuns)),
    riskyActions: unique(policies.flatMap(({ riskyActions }) => riskyActions)),
  }
}

function assertAuthorized(
  policy: Policy,
  constraints: readonly Constraint[],
  target: PinnedDefinitionRef,
): boolean {
  const action = `${target.kind}:${target.id}`
  const matches = (patterns: readonly string[]) => patterns.some((pattern) => pattern === "*" || pattern === target.id || pattern === action)
  if (matches(policy.authority.deny)) throw new Error(`Dispatch blocked: authority denies "${action}"`)
  if (!matches(policy.authority.allow)) throw new Error(`Dispatch blocked: authority does not allow "${action}"`)
  const matchingConstraints = constraints.filter(({ actions }) => matches(actions))
  const denied = matchingConstraints.find(({ effect }) => effect === "deny")
  if (denied) throw new Error(`Dispatch blocked by constraint "${denied.id}": ${denied.rule}`)
  const requiresApproval =
    policy.approval === "all-actions" ||
    (policy.approval === "risky-actions" && matches(policy.riskyActions)) ||
    matchingConstraints.some(({ effect }) => effect === "require-approval")
  return requiresApproval
}

function pinned<T extends { definition: { id: string }; revision: string }>(
  kind: PinnedDefinitionRef["kind"],
  record: T,
): PinnedDefinitionRef {
  return { kind, id: record.definition.id, revision: record.revision }
}

function intersect(groups: readonly string[][]): string[] {
  if (groups.length === 0) return []
  if (groups.every((group) => group.includes("*"))) return ["*"]
  const candidates = unique(groups.flatMap((group) => group.filter((item) => item !== "*")))
  return candidates.filter((candidate) => groups.every((group) => group.includes("*") || group.includes(candidate)))
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}
