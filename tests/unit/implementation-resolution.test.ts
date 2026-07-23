import { describe, expect, it } from "vitest"
import {
  ImplementationResolutionError,
  resolveCapabilityImplementation,
} from "../../src/agency/implementation-resolution.js"

const implementations = [
  {
    id: "graphify-knowledge-graph",
    capabilityRef: { kind: "capability" as const, id: "build-knowledge-graph" },
    compatibleCapabilityRevision: "contract-ref",
    type: "agent" as const,
    agentRef: { kind: "agent" as const, id: "knowledge-engineer" },
  },
  {
    id: "script-knowledge-graph",
    capabilityRef: { kind: "capability" as const, id: "build-knowledge-graph" },
    compatibleCapabilityRevision: "contract-ref",
    type: "script" as const,
  },
]

describe("Capability Implementation resolution", () => {
  it("uses an authorized explicit override before a repository binding", () => {
    expect(
      resolveCapabilityImplementation({
        capabilityId: "build-knowledge-graph",
        capabilityRevision: "contract-ref",
        implementations,
        explicitOverride: "script-knowledge-graph",
        repositoryBinding: "graphify-knowledge-graph",
        authorizeOverride: () => true,
      }).id,
    ).toBe("script-knowledge-graph")
  })

  it("uses a compatible repository binding", () => {
    expect(
      resolveCapabilityImplementation({
        capabilityId: "build-knowledge-graph",
        capabilityRevision: "contract-ref",
        implementations,
        repositoryBinding: "graphify-knowledge-graph",
      }).id,
    ).toBe("graphify-knowledge-graph")
  })

  it("uses the only compatible implementation", () => {
    expect(
      resolveCapabilityImplementation({
        capabilityId: "build-knowledge-graph",
        capabilityRevision: "contract-ref",
        implementations: [implementations[0]!],
      }).id,
    ).toBe("graphify-knowledge-graph")
  })

  it("rejects ambiguity, incompatible bindings, and unauthorized overrides", () => {
    expect(() =>
      resolveCapabilityImplementation({
        capabilityId: "build-knowledge-graph",
        capabilityRevision: "contract-ref",
        implementations,
      }),
    ).toThrowError(ImplementationResolutionError)
    expect(() =>
      resolveCapabilityImplementation({
        capabilityId: "build-knowledge-graph",
        capabilityRevision: "other-contract",
        implementations,
        repositoryBinding: "graphify-knowledge-graph",
      }),
    ).toThrow(/not compatible/)
    expect(() =>
      resolveCapabilityImplementation({
        capabilityId: "build-knowledge-graph",
        capabilityRevision: "contract-ref",
        implementations,
        explicitOverride: "script-knowledge-graph",
        authorizeOverride: () => false,
      }),
    ).toThrow(/not authorized/)
  })
})
