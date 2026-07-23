export type ImplementationDefinition =
  | {
      id: string
      capabilityRef: { kind: "capability"; id: string }
      compatibleCapabilityRevision: string
      type: "agent"
      agentRef: { kind: "agent"; id: string }
    }
  | {
      id: string
      capabilityRef: { kind: "capability"; id: string }
      compatibleCapabilityRevision: string
      type: "script"
    }

export class ImplementationResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ImplementationResolutionError"
  }
}

export interface ResolveCapabilityImplementationInput {
  capabilityId: string
  capabilityRevision: string
  implementations: readonly ImplementationDefinition[]
  explicitOverride?: string
  repositoryBinding?: string
  authorizeOverride?: (implementationId: string) => boolean
}

export function resolveCapabilityImplementation(input: ResolveCapabilityImplementationInput): ImplementationDefinition {
  const compatible = input.implementations.filter(
    (implementation) =>
      implementation.capabilityRef.id === input.capabilityId &&
      implementation.compatibleCapabilityRevision === input.capabilityRevision,
  )

  if (input.explicitOverride) {
    if (!input.authorizeOverride?.(input.explicitOverride)) {
      throw new ImplementationResolutionError(`Implementation override "${input.explicitOverride}" is not authorized`)
    }
    return selectNamed(input.explicitOverride, input, compatible, "override")
  }

  if (input.repositoryBinding) {
    return selectNamed(input.repositoryBinding, input, compatible, "repository binding")
  }

  if (compatible.length === 1) return compatible[0]!
  if (compatible.length === 0) {
    throw new ImplementationResolutionError(
      `No compatible Implementation is available for Capability "${input.capabilityId}" at revision "${input.capabilityRevision}"`,
    )
  }
  throw new ImplementationResolutionError(
    `Capability "${input.capabilityId}" has ${compatible.length} compatible Implementations; configure a repository binding`,
  )
}

function selectNamed(
  id: string,
  input: ResolveCapabilityImplementationInput,
  compatible: readonly ImplementationDefinition[],
  source: string,
): ImplementationDefinition {
  const known = input.implementations.find((implementation) => implementation.id === id)
  if (!known) {
    throw new ImplementationResolutionError(`Implementation ${source} "${id}" is not available`)
  }
  const selected = compatible.find((implementation) => implementation.id === id)
  if (!selected) {
    throw new ImplementationResolutionError(
      `Implementation ${source} "${id}" is not compatible with Capability "${input.capabilityId}" at revision "${input.capabilityRevision}"`,
    )
  }
  return selected
}
