import { readRuntimeConnectionFromKody } from "../kody-api-client.js"

export interface RuntimeConnection {
  id: string
  name: string
  provider: string
  accountType: string
  externalId: string
  credentialRefs: Record<string, string>
  status: "connected" | "needs_attention" | "disabled"
  verifiedAt: string | null
}

export async function resolveRuntimeConnections(
  ids: unknown,
  declaredSecrets: unknown,
  load: (id: string) => Promise<RuntimeConnection | null> = readRuntimeConnectionFromKody,
): Promise<RuntimeConnection[]> {
  const requested = Array.isArray(ids)
    ? [...new Set(ids.filter((id): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)))]
    : []
  const allowedSecrets = new Set(
    Array.isArray(declaredSecrets) ? declaredSecrets.filter((name): name is string => typeof name === "string") : [],
  )
  const connections: RuntimeConnection[] = []
  for (const id of requested) {
    const connection = await load(id)
    if (!connection) throw new Error(`Connection ${id} was not found`)
    if (connection.status !== "connected") throw new Error(`Connection ${id} is not connected`)
    for (const secretName of Object.values(connection.credentialRefs)) {
      if (!allowedSecrets.has(secretName)) {
        throw new Error(`Connection ${id} credential ${secretName} is not allowlisted by the Capability`)
      }
    }
    connections.push(connection)
  }
  return connections
}
