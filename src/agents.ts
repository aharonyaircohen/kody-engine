/**
 * Load an agent's agent for an executable that declares `agent:`.
 *
 * This is the generic, executor-level version of what the capability/tick path does
 * via the `{{agentIdentity}}` prompt token (see loadJobFromFile.ts /
 * loadAgentAdhoc.ts). A `agent` field on a profile lets the executor run that
 * executable *as* a named agent.
 *
 * Resolution mirrors the capability path: hydrated local
 * `.kody/agents/<slug>.md`, frontmatter stripped, body returned. A declared-but-missing agent file is fatal — an
 * executable must never silently run without the identity it asked for.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { getCompanyStoreAssetRoot } from "./companyStore.js"

const DEFAULT_AGENT_DIR = ".kody/agents"

/**
 * Engine-default agent identities that resolve without a hydrated file.
 *
 * Used as a last-resort fallback when a profile declares `agent: kody` and
 * neither the local `.kody/agents/kody.md` nor the company store supplies one.
 * Without this, a consumer that has not authored an agent file would crash on
 * every kody-routed run. A consumer-authored file (even one in the company
 * store) always wins over the built-in.
 */
export const BUILTIN_AGENTS: Record<string, string> = {
  kody: [
    "# Kody",
    "",
    "You are Kody, the autonomous development engine that runs this executable.",
    "Stay terse, prefer the smallest correct change, and surface blockers instead of papering over them.",
  ].join("\n"),
}

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
 * matching agent-ask's prompt. Returned block is meant to lead the executable's
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
