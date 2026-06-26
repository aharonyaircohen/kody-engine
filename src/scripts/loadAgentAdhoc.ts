/**
 * Preflight for `agent-ask`: load an agent identity and an inline message
 * for a stateless, ad-hoc tick. No capability folder, no job state, no commit.
 *
 * This is the engine half of the dashboard's "@mention an agent in a
 * message" feature: an agent is a stateless agent, so an ad-hoc
 * request is just that agent answering one inline prompt — there is no
 * `.kody/capabilities/<slug>/`, no cadence, and nothing to persist.
 *
 * Message resolution (production vs. CLI):
 *   1. The dispatching `issue_comment` body (GITHUB_EVENT_PATH), with the
 *      leading `@kody agent-ask ...` directive line stripped. This path
 *      preserves the message verbatim — newlines, code blocks, markdown —
 *      because it never goes through whitespace-collapsing arg tokenizing.
 *   2. Fallback: `ctx.args.message` (the `bindsCommentRest` input), for
 *      local CLI / tests where no GitHub event file exists.
 *
 * Sets:
 *   ctx.data.agentSlug     the agent slug
 *   ctx.data.agentTitle    agent file H1, or humanized slug
 *   ctx.data.agentIdentity  agent identity body (post-frontmatter)
 *   ctx.data.message        the inline request (verbatim)
 *   ctx.data.thread         discussion number to reply into, or ""
 *
 * Script args (via `with:`):
 *   agentsDir    optional — default ".kody/agents"
 */

import * as fs from "node:fs"
import { resolveAgentFile } from "../agents.js"
import type { PreflightScript } from "../executables/types.js"

export const loadAgentAdhoc: PreflightScript = async (ctx, _profile, args) => {
  const agentsDir = String(args?.agentsDir ?? ".kody/agents")
  const agentSlug = String(ctx.args.agent ?? "").trim()
  if (!agentSlug) {
    throw new Error("loadAgentAdhoc: ctx.args.agent must be a non-empty slug")
  }

  const agentPath = resolveAgentFile(ctx.cwd, agentSlug, agentsDir)
  if (!fs.existsSync(agentPath)) {
    throw new Error(`loadAgentAdhoc: agent identity not found: ${agentPath}`)
  }
  const { title, body } = parseAgentFile(fs.readFileSync(agentPath, "utf-8"), agentSlug)

  const message = resolveMessage(ctx.args.message)
  if (!message) {
    throw new Error(
      "loadAgentAdhoc: no message — neither the dispatching comment body nor ctx.args.message provided one",
    )
  }

  ctx.data.agentSlug = agentSlug
  ctx.data.agentTitle = title
  ctx.data.agentIdentity = body
  ctx.data.message = message
  ctx.data.thread = String(ctx.args.thread ?? "").trim()
}

/**
 * Prefer the verbatim dispatching comment body (newlines/markdown intact);
 * fall back to the tokenized `message` arg for CLI/test runs.
 */
function resolveMessage(messageArg: unknown): string {
  const fromComment = readCommentBody()
  if (fromComment) return stripDirective(fromComment)
  return String(messageArg ?? "").trim()
}

function readCommentBody(): string {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return ""
  try {
    const event = JSON.parse(fs.readFileSync(eventPath, "utf-8")) as {
      comment?: { body?: string }
    }
    return String(event.comment?.body ?? "")
  } catch {
    return ""
  }
}

/**
 * Drop the `@kody agent-ask ...` invocation line(s) from the top of the
 * comment so the agent sees only the human's actual request + context.
 * Only contiguous leading lines that contain the directive are removed —
 * a later line that merely mentions `@kody` in prose is preserved.
 */
function stripDirective(body: string): string {
  const lines = body.split("\n")
  let start = 0
  while (start < lines.length) {
    const line = lines[start]!.trim()
    if (line.length === 0) {
      start++
      continue
    }
    if (/@kody\s+agent-ask\b/i.test(line)) {
      start++
      continue
    }
    break
  }
  return lines.slice(start).join("\n").trim()
}

function parseAgentFile(raw: string, slug: string): { title: string; body: string } {
  const stripped = stripLeadingFrontmatter(raw)
  const trimmed = stripped.trim()
  const firstLine = trimmed.split("\n", 1)[0] ?? ""
  const h1 = /^#\s+(.+?)\s*$/.exec(firstLine)
  if (h1) {
    const rest = trimmed.slice(firstLine.length).replace(/^\n+/, "")
    return { title: h1[1]!.trim(), body: rest }
  }
  return { title: humanizeSlug(slug), body: trimmed }
}

function stripLeadingFrontmatter(raw: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw)
  return match ? raw.slice(match[0].length) : raw
}

function humanizeSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter((s) => s.length > 0)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join(" ")
}
