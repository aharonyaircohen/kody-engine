/**
 * Load an agent's agent for an agentAction that declares `agent:`.
 *
 * This is the generic, executor-level version of what the agentResponsibility/tick path does
 * via the `{{agentIdentity}}` prompt token (see loadJobFromFile.ts /
 * loadAgentAdhoc.ts). A `agent` field on a profile lets the executor run that
 * agentAction *as* a named agent.
 *
 * Resolution mirrors the agentResponsibility path: hydrated local
 * `.kody/agents/<slug>.md`, frontmatter stripped, body returned. A declared-but-missing agent file is fatal — an
 * agentAction must never silently run without the identity it asked for.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { getCompanyStoreAssetRoot } from "./companyStore.js"

const DEFAULT_AGENT_DIR = ".kody/agents"

/** Agent identitys live in the hydrated local `.kody/agents` cache or the configured company store. */
export const BUILTIN_AGENTS: Record<string, string> = {}

/** Strip a leading `---\n…\n---\n` frontmatter block; return the body. */
function stripFrontmatter(raw: string): string {
  const match = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(raw)
  return (match ? match[1]! : raw).trim()
}

/**
 * Read the agent identity body for `slug`.
 *
 * Resolution order:
 * 1. Hydrated local file `<cwd>/<agentsDir>/<slug>.md` (non-empty) — always wins.
 * 2. Company store agent file.
 * 3. Otherwise throw — declared agent with no source must not run.
 */
export function loadAgentIdentity(cwd: string, slug: string, agentsDir: string = DEFAULT_AGENT_DIR): string {
  const trimmed = slug.trim()
  if (!trimmed) throw new Error("loadAgentIdentity: empty agent slug")
  const agentPath = resolveAgentFile(cwd, trimmed, agentsDir)
  if (fs.existsSync(agentPath)) {
    const body = stripFrontmatter(fs.readFileSync(agentPath, "utf-8"))
    if (body) return body
    // File present but empty: fall back to a built-in if one exists, else
    // preserve the legacy "body is empty" error.
    const builtinForEmpty = BUILTIN_AGENTS[trimmed]
    if (builtinForEmpty) return builtinForEmpty
    throw new Error(`loadAgentIdentity: agent '${trimmed}' agent identity body is empty (${agentPath})`)
  }
  const builtin = BUILTIN_AGENTS[trimmed]
  if (builtin) return builtin
  throw new Error(`loadAgentIdentity: agent '${trimmed}' declared but ${agentPath} does not exist`)
}

export function resolveAgentFile(cwd: string, slug: string, agentsDir: string = DEFAULT_AGENT_DIR): string {
  const localPath = path.join(cwd, agentsDir, `${slug}.md`)
  if (fs.existsSync(localPath)) return localPath

  const storeAgentRoot = getCompanyStoreAssetRoot("agents")
  if (storeAgentRoot) {
    const storePath = path.join(storeAgentRoot, `${slug}.md`)
    if (fs.existsSync(storePath)) return storePath
  }

  return localPath
}

/**
 * Wrap an agent identity body in the authoritative-identity framing the agent expects,
 * matching agent-ask's prompt. Returned block is meant to lead the agentAction's
 * system-prompt append so identity sits ahead of task-specific instructions.
 */
export function frameAgentIdentity(slug: string, agent: string): string {
  return [
    `## Who you are — agent identity (authoritative identity)`,
    ``,
    `You are operating as agent \`${slug}\`. This identity defines *who* you are:`,
    `your authority, doctrine, voice, and hard limits. Honour it exactly. Where the`,
    `this identity's restrictions are stricter than the task, **the agent wins** — a task`,
    `can never grant you authority your agent withholds.`,
    ``,
    agent,
  ].join("\n")
}
