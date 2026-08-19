import * as fs from "node:fs"
import { agentsRoot } from "../definition-paths.js"
import { loadAgentIdentity, resolveAgentFile } from "../agents.js"
import type { PreflightScript } from "../implementations/types.js"
import { createStateBackendFromEnv } from "../state-backend.js"

interface GuidanceDoc { kind: string; doc?: { body?: unknown } }

function tenant(config: { github?: { owner?: string; repo?: string } }): string {
  const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY ?? "").split("/")
  const owner = config.github?.owner?.trim() || envOwner
  const repo = config.github?.repo?.trim() || envRepo
  if (!owner || !repo) throw new Error("Repository identity is required for live Agent execution")
  return `${owner}/${repo}`
}

function frontmatter(raw: string): Record<string, string | string[]> {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw)
  if (!match) return {}
  const result: Record<string, string | string[]> = {}
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":")
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    result[key] = value.startsWith("[")
      ? value.slice(1, -1).split(",").map((entry) => entry.trim()).filter(Boolean)
      : value
  }
  return result
}

function guidanceBody(row: GuidanceDoc, agent: string): string | null {
  if (typeof row.doc?.body !== "string") return null
  const metadata = frontmatter(row.doc.body)
  const audience = Array.isArray(metadata.agent) ? metadata.agent : [metadata.agent ?? "*"]
  if (!audience.includes("*") && !audience.includes(agent)) return null
  return row.doc.body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()
}

function intentBody(row: GuidanceDoc): string | null {
  if (typeof row.doc?.body !== "string") return null
  return row.doc.body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim() || null
}

export const loadLiveAgent: PreflightScript = async (ctx, profile) => {
  const agent = String(ctx.args.agent ?? ctx.data.jobAgent ?? "").trim()
  if (!agent) throw new Error("loadLiveAgent: agent is required")
  const file = resolveAgentFile(ctx.cwd, agent, agentsRoot(ctx.cwd))
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const metadata = frontmatter(raw)
  const assignedIntent = typeof metadata.primaryIntent === "string" ? metadata.primaryIntent : ""
  const requestedIntent = String(ctx.args.intent ?? "").trim()
  const intent = requestedIntent || assignedIntent
  if (!intent || (requestedIntent && assignedIntent !== requestedIntent)) {
    throw new Error(`Live Agent '${agent}' does not have the requested primary Intent`)
  }

  const backend = createStateBackendFromEnv()
  const tenantId = tenant(ctx.config)
  const [stateRow, intentRow, policies, constraints, context] = await Promise.all([
    backend.getAgentState(tenantId, agent),
    backend.getRepoDoc(tenantId, `intent:${intent}`),
    backend.listRepoDocs(tenantId, "policy:"),
    backend.listRepoDocs(tenantId, "constraint:"),
    backend.listRepoDocs(tenantId, "context:"),
  ])
  if (!stateRow) throw new Error(`Live Agent '${agent}' has no AgentState`)
  const state = stateRow.state as { revision?: number; cursor?: string; data?: Record<string, unknown> }
  const selectedIntentBody = intentRow ? intentBody(intentRow as GuidanceDoc) : null
  if (!selectedIntentBody) throw new Error(`Primary Intent '${intent}' is missing`)
  const render = (rows: unknown[]) =>
    (rows as GuidanceDoc[]).map((row) => guidanceBody(row, agent)).filter(Boolean).join("\n\n") || "None assigned."

  ctx.data.agentIdentity = loadAgentIdentity(ctx.cwd, agent)
  ctx.data.liveAgentIntent = selectedIntentBody
  ctx.data.liveAgentPolicies = render(policies)
  ctx.data.liveAgentConstraints = render(constraints)
  ctx.data.liveAgentContext = render(context)
  ctx.data.liveAgentCapabilities = Array.isArray(metadata.capabilities)
    ? metadata.capabilities.map((slug) => `- ${slug}`).join("\n")
    : "None assigned."
  ctx.data.liveAgentSlug = agent
  ctx.data.liveAgentPreviousRevision = Number(state.revision ?? 0)
  ctx.data.jobState = {
    state: {
      version: 1,
      rev: Number(state.revision ?? 0),
      cursor: String(state.cursor ?? "idle"),
      data: state.data ?? {},
      done: false,
    },
  }
  ctx.data.jobStateJson = JSON.stringify(state, null, 2)
  ctx.data.capabilityTools = ["start_capability"]
  ctx.data.capabilityToolMode = "lock"
  profile.claudeCode.enableSubmitTool = true
}
