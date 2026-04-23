/**
 * Preflight: fetch the diff + review comments of prior-art PRs named by an
 * upstream producer (today: research → priorArt artifact) and expose them on
 * ctx.data so the prompt template can reference them via `{{priorArt}}`.
 *
 * Contract:
 *   Input — state.artifacts[<artifactName>].content, a JSON array of PR
 *           numbers (number[]). Default artifactName = "priorArt".
 *   Output — ctx.data.priorArt: a formatted markdown block (possibly empty).
 *
 * Design:
 *   - Pure consumer of state. Does not parse prose. Does not know about
 *     "research" or "plan" — any executable that wants prior art can use it.
 *   - Tolerant of absence: missing artifact / empty array / invalid JSON all
 *     produce an empty block without erroring, because prior art is advisory
 *     context, not a required input. The planner is capable without it.
 *   - Bounded output: per-PR diffs capped at PER_PR_DIFF_MAX_BYTES, whole
 *     block capped at TOTAL_MAX_BYTES, to avoid blowing the prompt budget
 *     when a prior PR was large.
 */

import type { PreflightScript } from "../executables/types.js"
import { gh } from "../issue.js"
import type { TaskState } from "../state.js"

const PER_PR_DIFF_MAX_BYTES = 8_000
const TOTAL_MAX_BYTES = 30_000
const TRUNCATED_SUFFIX = "\n\n… (truncated)"

export const loadPriorArt: PreflightScript = async (ctx, _profile, args) => {
  const artifactName = typeof args?.artifactName === "string" ? args.artifactName : "priorArt"

  const state = ctx.data.taskState as TaskState | undefined
  const artifact = state?.artifacts?.[artifactName]
  const prNumbers = parsePrNumbers(artifact?.content)
  if (prNumbers.length === 0) {
    ctx.data.priorArt = ""
    return
  }

  const blocks: string[] = []
  for (const n of prNumbers) {
    const block = fetchPrBlock(n, ctx.cwd)
    if (block) blocks.push(block)
  }

  const joined = blocks.join("\n\n---\n\n")
  ctx.data.priorArt = joined.length > TOTAL_MAX_BYTES ? joined.slice(0, TOTAL_MAX_BYTES) + TRUNCATED_SUFFIX : joined
}

function parsePrNumbers(raw: string | undefined): number[] {
  if (!raw) return []
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

function fetchPrBlock(prNumber: number, cwd: string): string {
  try {
    const metaRaw = gh(["pr", "view", String(prNumber), "--json", "title,state,url,mergedAt,closedAt"], { cwd })
    const meta = JSON.parse(metaRaw) as { title?: string; state?: string; url?: string }
    const diff = truncate(safeGh(["pr", "diff", String(prNumber)], cwd), PER_PR_DIFF_MAX_BYTES)
    const commentsRaw = safeGh(["pr", "view", String(prNumber), "--json", "comments,reviews"], cwd)
    const commentsBlock = formatReviewComments(commentsRaw)

    const lines = [
      `## Prior art: PR #${prNumber} — ${meta.title ?? "(no title)"} [${meta.state ?? "unknown"}]`,
      meta.url ? meta.url : "",
      "",
      "### Diff",
      "```diff",
      diff || "(empty)",
      "```",
    ]
    if (commentsBlock) {
      lines.push("")
      lines.push("### Review comments")
      lines.push(commentsBlock)
    }
    return lines.filter((l) => l !== "").join("\n")
  } catch (err) {
    return `## Prior art: PR #${prNumber}\n_Could not fetch — ${err instanceof Error ? err.message : String(err)}_`
  }
}

function safeGh(args: string[], cwd: string): string {
  try {
    return gh(args, { cwd })
  } catch {
    return ""
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + TRUNCATED_SUFFIX
}

function formatReviewComments(raw: string): string {
  if (!raw) return ""
  try {
    const parsed = JSON.parse(raw) as {
      comments?: Array<{ author?: { login?: string }; body?: string }>
      reviews?: Array<{ author?: { login?: string }; body?: string; state?: string }>
    }
    const out: string[] = []
    for (const c of parsed.comments ?? []) {
      if (!c.body) continue
      out.push(`- **${c.author?.login ?? "unknown"}**: ${c.body.replace(/\n/g, " ").slice(0, 500)}`)
    }
    for (const r of parsed.reviews ?? []) {
      if (!r.body && !r.state) continue
      const state = r.state ? ` (${r.state})` : ""
      const body = r.body ? `: ${r.body.replace(/\n/g, " ").slice(0, 500)}` : ""
      out.push(`- **${r.author?.login ?? "unknown"}**${state}${body}`)
    }
    return out.join("\n")
  } catch {
    return ""
  }
}
