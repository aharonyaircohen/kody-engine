/**
 * Preflight: load a file-based agentResponsibility (body from disk, state via the
 * configured `JobStateBackend`) into ctx.data. Mirror of
 * `loadIssueStateComment` for the file-based agentResponsibility model.
 *
 * Reads the folder body at `<jobsDir>/<slug>/agent-responsibility.md` and the agentResponsibility's
 * state via `resolveBackend(config, cwd, jobsDir).load(slug)`. Sets:
 *
 *   ctx.data.jobSlug         the slug (legacy token; remains canonical for
 *                            the kody-job-next-state fence label and existing
 *                            prompt templates)
 *   ctx.data.jobTitle        first H1 of the body, or slug formatted
 *   ctx.data.jobIntent       the agentResponsibility body
 *   ctx.data.jobStateJson    rendered prior state, or seed on first run
 *   ctx.data.jobState        LoadedJobState (path, handle, state, created)
 *   ctx.data.agentSlug      the assigned agent slug (or "" if none)
 *   ctx.data.agentTitle     agent file H1, or humanized agent slug
 *   ctx.data.agentIdentity   agent identity body (post-frontmatter), or ""
 *   ctx.data.mentions        "@a @b" from the agentResponsibility profile's `mentions`, or ""
 *
 *   ctx.data.agentResponsibilitySlug        alias of jobSlug — the "AgentResponsibility" noun introduced
 *                            by Phase 1 of the agentResponsibility-pipeline rename
 *   ctx.data.agentResponsibilityTitle       alias of jobTitle
 *   ctx.data.agentSlug       alias of agentSlug — the agent (who)
 *   ctx.data.agentTitle      alias of agentTitle
 *   ctx.data.agentActionSlug  profile.name — the agentAction doing the tick (how)
 *
 * The agent is *who* the tick runs as: a agentResponsibility names exactly one
 * agent via `profile.json`; its agent is injected ahead of the agentResponsibility
 * body by `agent-responsibility-tick`. An agent slug that points at a missing file is a hard
 * error — a agentResponsibility must not silently run with no executor identity.
 *
 * Script args (via `with:`):
 *   jobsDir       optional — default ".kody/agent-responsibilities"
 *   agentsDir    optional — default ".kody/agents"
 *   slugArg       optional — name of the CLI input holding the slug (default "job")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../agent-actions/types.js"
import { AGENT_RESPONSIBILITY_MCP_TOOL_NAMES } from "../agent-responsibilityMcp.js"
import { resolveAgentFile } from "../agents.js"
import { resolveAgentResponsibilityFolder } from "../registry.js"
import { resolveBackend } from "./jobState/index.js"

const AGENT_RESPONSIBILITY_TOOL_PALETTE: ReadonlySet<string> = new Set(AGENT_RESPONSIBILITY_MCP_TOOL_NAMES)

export const loadJobFromFile: PreflightScript = async (ctx, profile, args) => {
  const jobsDir = String(args?.jobsDir ?? ".kody/agent-responsibilities")
  const agentsDir = String(args?.agentsDir ?? ".kody/agents")
  const slugArg = String(args?.slugArg ?? "job")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    throw new Error(`loadJobFromFile: ctx.args.${slugArg} must be a non-empty slug`)
  }

  const agentResponsibility = resolveAgentResponsibilityFolder(slug, path.join(ctx.cwd, jobsDir))
  if (!agentResponsibility) {
    throw new Error(
      `loadJobFromFile: agentResponsibility folder not found or incomplete: ${path.join(ctx.cwd, jobsDir, slug)}`,
    )
  }
  const { title, body, config } = agentResponsibility

  // Logins this agentResponsibility's output should @-mention, declared via `mentions`
  // in profile.json (stored without `@`). Emit a ready-to-insert
  // string here — composePrompt only stringifies ctx.data values, so the
  // `{{mentions}}` token must already be the finished "@a @b" form. Empty
  // string when none are declared. Fail-soft: never throws.
  const mentions = (config.mentions ?? []).map((login: string) => `@${login}`).join(" ")

  // Resolve the assigned agent (agent) — *who* this tick runs as.
  // The agentResponsibility owns scheduling; the agent is identity/doctrine injected
  // ahead of the agentResponsibility body. A `agent` value pointing at a missing file is fatal: a
  // agentResponsibility must never run without the executor identity it declared.
  const agentSlug = (config.agent ?? "").trim()
  let agentTitle = ""
  let agentIdentity = ""
  if (agentSlug) {
    const agentPath = resolveAgentFile(ctx.cwd, agentSlug, agentsDir)
    if (!fs.existsSync(agentPath)) {
      throw new Error(
        `loadJobFromFile: agentResponsibility '${slug}' declares agent '${agentSlug}' but ${agentPath} does not exist`,
      )
    }
    const agentRaw = fs.readFileSync(agentPath, "utf-8")
    const parsed = parseJobFile(agentRaw, agentSlug)
    agentTitle = parsed.title
    agentIdentity = parsed.body
  }

  // Backend-agnostic load. Returns a seed envelope on first run.
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  const loaded = await backend.load(slug)

  ctx.data.jobSlug = slug
  ctx.data.jobTitle = title
  // Resolve {{mentions}} inside the agentResponsibility body here. composePrompt only renders
  // mustache tokens in the agentAction *template*; the body lands via the
  // template's {{jobIntent}} token and is never re-scanned, so a `{{mentions}}`
  // written in a agentResponsibility body would otherwise reach the agent literal — and the
  // agent then improvises (and mistypes) the operator handle. Substitute it to
  // the finished "@a @b" form now (empty string when none declared; fail-soft).
  // Also resolve {{agentResponsibility}} → this agentResponsibility's slug, so a agentResponsibility body can stamp its own
  // recommendations with `<!-- kody-agentResponsibility: {{agentResponsibility}} -->`. AgentResponsibilities that post recs
  // as plain comments (e.g. the QA agentResponsibilities) need this — the engine only
  // auto-stamps recs sent via the `recommend_to_operator` tool. The dashboard
  // reads the stamp to key trust per agentResponsibility instead of per agent.
  ctx.data.jobIntent = body
    .replace(/\{\{\s*mentions\s*\}\}/g, mentions)
    .replace(/\{\{\s*agentResponsibility\s*\}\}/g, slug)
  ctx.data.jobState = loaded
  ctx.data.jobStateJson = JSON.stringify(loaded.state, null, 2)
  ctx.data.agentSlug = agentSlug
  ctx.data.agentTitle = agentTitle
  ctx.data.agentIdentity = agentIdentity
  ctx.data.mentions = mentions

  // AgentResponsibility-noun aliases. The domain noun for one tick of a markdown agentResponsibility is
  // "AgentResponsibility", not "Job" — the engine's `Job` runtime envelope (src/job.ts) and
  // the scheduled-watch agentAction shape are a separate concern, see AGENTS.md.
  // The legacy `jobSlug` / `jobTitle` / `agentSlug` / `agentTitle` fields
  // stay populated above for backwards compat with the kody-job-next-state
  // fence label, existing prompt templates, and any operator-written agentResponsibility
  // bodies that still reference the old tokens.
  ctx.data.agentResponsibilitySlug = slug
  ctx.data.agentResponsibilityTitle = title
  ctx.data.agentSlug = agentSlug
  ctx.data.agentTitle = agentTitle
  ctx.data.agentActionSlug = profile.name
  ctx.data.agentResponsibilitySchedule = config.every ?? ""

  // Locked-toolbox mode (`tools` in profile.json). When declared, the agentResponsibility body
  // is pure intent — the LLM picks tools by name from the kody-agentResponsibility palette
  // and never sees Bash/Read/gh. This closes the long-running bug class where
  // agentResponsibility scripts post `@kody <verb>` comments the engine then silently drops.
  //
  // Mutate the profile in place so the executor's runAgent invocation picks up
  // the locked allowedTools + mcpServer flag without needing a side-channel.
  const declaredTools = config.tools ?? []
  if (declaredTools.length > 0) {
    const unknown = declaredTools.filter((name: string) => !AGENT_RESPONSIBILITY_TOOL_PALETTE.has(name))
    if (unknown.length > 0) {
      throw new Error(
        `loadJobFromFile: agentResponsibility '${slug}' declared tools not in the kody-agentResponsibility palette: ${unknown.join(", ")}. ` +
          `Available: ${[...AGENT_RESPONSIBILITY_MCP_TOOL_NAMES].join(", ")}`,
      )
    }
    // Revoke shell + Read; keep submit_state (state persistence). The LLM can
    // now only call mcp__kody-agent-responsibility__<tool> + mcp__kody-submit__submit_state.
    const mcpToolNames = declaredTools.map((name: string) => `mcp__kody-agent-responsibility__${name}`)
    profile.claudeCode.tools = [...mcpToolNames, "mcp__kody-submit__submit_state"]
    ctx.data.agentResponsibilityTools = declaredTools
    ctx.data.agentResponsibilityOperatorMention = mentions
    // Switch the prompt template: composePrompt picks `prompts/<mode>.md` when
    // ctx.data.promptTemplate is set. The locked template assumes no shell —
    // its instructions reference the agentResponsibility MCP tools by name, not `gh`.
    ctx.data.promptTemplate = "prompts/locked.md"
    // Render the tool palette as a tight, bulletable list for the prompt.
    ctx.data.agentResponsibilityToolsList = declaredTools.map((name: string) => `- \`${name}\``).join("\n")
  }
}

interface ParsedJob {
  title: string
  body: string
}

function parseJobFile(raw: string, slug: string): ParsedJob {
  // Agent identitys may carry their own small metadata block. AgentResponsibility metadata is
  // not read here; folder agentResponsibilities use profile.json via readAgentResponsibilityFolder().
  let stripped = raw
  if (stripped.startsWith("---\n")) {
    const end = stripped.indexOf("\n---\n", 4)
    if (end !== -1) {
      stripped = stripped.slice(end + 5)
    }
  }
  const trimmed = stripped.trim()
  const firstLine = trimmed.split("\n", 1)[0] ?? ""
  const h1 = /^#\s+(.+?)\s*$/.exec(firstLine)
  if (h1) {
    const rest = trimmed.slice(firstLine.length).replace(/^\n+/, "")
    return { title: h1[1]!.trim(), body: rest }
  }
  return { title: humanizeSlug(slug), body: trimmed }
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ")
}
