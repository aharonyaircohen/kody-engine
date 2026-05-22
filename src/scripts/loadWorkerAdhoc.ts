/**
 * Preflight for `worker-ask`: load a worker persona and an inline message
 * for a stateless, ad-hoc tick. No job file, no job state, no commit.
 *
 * This is the engine half of the dashboard's "@mention a staff member in a
 * message" feature: a staff member is a stateless persona, so an ad-hoc
 * request is just that persona answering one inline prompt — there is no
 * `.kody/duties/<slug>.md`, no cadence, and nothing to persist.
 *
 * Message resolution (production vs. CLI):
 *   1. The dispatching `issue_comment` body (GITHUB_EVENT_PATH), with the
 *      leading `@kody worker-ask ...` directive line stripped. This path
 *      preserves the message verbatim — newlines, code blocks, markdown —
 *      because it never goes through whitespace-collapsing arg tokenizing.
 *   2. Fallback: `ctx.args.message` (the `bindsCommentRest` input), for
 *      local CLI / tests where no GitHub event file exists.
 *
 * Sets:
 *   ctx.data.workerSlug     the worker slug
 *   ctx.data.workerTitle    worker file H1, or humanized slug
 *   ctx.data.workerPersona  worker persona body (post-frontmatter)
 *   ctx.data.message        the inline request (verbatim)
 *   ctx.data.thread         discussion number to reply into, or ""
 *
 * Script args (via `with:`):
 *   workersDir    optional — default ".kody/staff"
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { splitFrontmatter } from "./jobFrontmatter.js"

export const loadWorkerAdhoc: PreflightScript = async (ctx, _profile, args) => {
  const workersDir = String(args?.workersDir ?? ".kody/staff")
  const workerSlug = String(ctx.args.worker ?? "").trim()
  if (!workerSlug) {
    throw new Error("loadWorkerAdhoc: ctx.args.worker must be a non-empty slug")
  }

  const workerPath = path.join(ctx.cwd, workersDir, `${workerSlug}.md`)
  if (!fs.existsSync(workerPath)) {
    throw new Error(`loadWorkerAdhoc: worker persona not found: ${workerPath}`)
  }
  const { title, body } = parsePersona(fs.readFileSync(workerPath, "utf-8"), workerSlug)

  const message = resolveMessage(ctx.args.message)
  if (!message) {
    throw new Error(
      "loadWorkerAdhoc: no message — neither the dispatching comment body nor ctx.args.message provided one",
    )
  }

  ctx.data.workerSlug = workerSlug
  ctx.data.workerTitle = title
  ctx.data.workerPersona = body
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
 * Drop the `@kody worker-ask ...` invocation line(s) from the top of the
 * comment so the persona sees only the human's actual request + context.
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
    if (/@kody\s+worker-ask\b/i.test(line)) {
      start++
      continue
    }
    break
  }
  return lines.slice(start).join("\n").trim()
}

function parsePersona(raw: string, slug: string): { title: string; body: string } {
  const stripped = splitFrontmatter(raw).body
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
