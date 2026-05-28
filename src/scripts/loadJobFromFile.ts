/**
 * Preflight: load a file-based job (body from disk, state via the
 * configured `JobStateBackend`) into ctx.data. Mirror of
 * `loadIssueStateComment` for the file-based job model.
 *
 * Reads the markdown body at `<jobsDir>/<slug>.md` and the job's
 * state via `resolveBackend(config, cwd, jobsDir).load(slug)`. Sets:
 *
 *   ctx.data.jobSlug         the slug
 *   ctx.data.jobTitle        first H1 of the body, or slug formatted
 *   ctx.data.jobIntent       the body (post-frontmatter, if any)
 *   ctx.data.jobStateJson    rendered prior state, or seed on first run
 *   ctx.data.jobState        LoadedJobState (path, handle, state, created)
 *   ctx.data.workerSlug      the assigned worker slug (or "" if none)
 *   ctx.data.workerTitle     worker file H1, or humanized worker slug
 *   ctx.data.workerPersona   worker persona body (post-frontmatter), or ""
 *   ctx.data.mentions        "@a @b" from the duty's `mentions:` frontmatter, or ""
 *
 * The staff member is *who* the tick runs as: a duty names exactly one
 * staff member via `staff:` frontmatter; its persona is injected ahead of
 * the duty body by `job-tick`. A `staff:` that points at a missing file is a
 * hard error — a duty must not silently run with no executor identity.
 *
 * Script args (via `with:`):
 *   jobsDir       optional — default ".kody/duties"
 *   workersDir    optional — default ".kody/staff"
 *   slugArg       optional — name of the CLI input holding the slug (default "job")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { DUTY_MCP_TOOL_NAMES } from "../dutyMcp.js"
import type { PreflightScript } from "../executables/types.js"
import { resolveBackend } from "./jobState/index.js"
import { splitFrontmatter } from "./jobFrontmatter.js"

const DUTY_TOOL_PALETTE: ReadonlySet<string> = new Set(DUTY_MCP_TOOL_NAMES)

export const loadJobFromFile: PreflightScript = async (ctx, profile, args) => {
  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const workersDir = String(args?.workersDir ?? ".kody/staff")
  const slugArg = String(args?.slugArg ?? "job")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    throw new Error(`loadJobFromFile: ctx.args.${slugArg} must be a non-empty slug`)
  }

  const absPath = path.join(ctx.cwd, jobsDir, `${slug}.md`)
  if (!fs.existsSync(absPath)) {
    throw new Error(`loadJobFromFile: job file not found: ${absPath}`)
  }
  const raw = fs.readFileSync(absPath, "utf-8")
  const { title, body } = parseJobFile(raw, slug)
  const frontmatter = splitFrontmatter(raw).frontmatter

  // Logins this duty's output should @-mention, declared via `mentions:`
  // frontmatter (comma-separated, stored without `@`). Emit a ready-to-insert
  // string here — composePrompt only stringifies ctx.data values, so the
  // `{{mentions}}` token must already be the finished "@a @b" form. Empty
  // string when none are declared. Fail-soft: never throws.
  const mentions = (frontmatter.mentions ?? []).map((login) => `@${login}`).join(" ")

  // Resolve the assigned staff member (persona) — *who* this tick runs as.
  // The duty owns scheduling; the staff member is identity/doctrine injected
  // ahead of the duty body. A `staff:` pointing at a missing file is fatal: a
  // duty must never run without the executor identity it declared.
  const workerSlug = (frontmatter.staff ?? "").trim()
  let workerTitle = ""
  let workerPersona = ""
  if (workerSlug) {
    const workerPath = path.join(ctx.cwd, workersDir, `${workerSlug}.md`)
    if (!fs.existsSync(workerPath)) {
      throw new Error(
        `loadJobFromFile: duty '${slug}' declares staff '${workerSlug}' but ${workerPath} does not exist`,
      )
    }
    const workerRaw = fs.readFileSync(workerPath, "utf-8")
    const parsed = parseJobFile(workerRaw, workerSlug)
    workerTitle = parsed.title
    workerPersona = parsed.body
  }

  // Backend-agnostic load. Returns a seed envelope on first run.
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  const loaded = await backend.load(slug)

  ctx.data.jobSlug = slug
  ctx.data.jobTitle = title
  // Resolve {{mentions}} inside the duty body here. composePrompt only renders
  // mustache tokens in the executable *template*; the body lands via the
  // template's {{jobIntent}} token and is never re-scanned, so a `{{mentions}}`
  // written in a duty body would otherwise reach the agent literal — and the
  // agent then improvises (and mistypes) the operator handle. Substitute it to
  // the finished "@a @b" form now (empty string when none declared; fail-soft).
  ctx.data.jobIntent = body.replace(/\{\{\s*mentions\s*\}\}/g, mentions)
  ctx.data.jobState = loaded
  ctx.data.jobStateJson = JSON.stringify(loaded.state, null, 2)
  ctx.data.workerSlug = workerSlug
  ctx.data.workerTitle = workerTitle
  ctx.data.workerPersona = workerPersona
  ctx.data.mentions = mentions

  // Locked-toolbox mode (`tools:` frontmatter). When declared, the duty body
  // is pure intent — the LLM picks tools by name from the kody-duty palette
  // and never sees Bash/Read/gh. This closes the long-running bug class where
  // duty scripts post `@kody <verb>` comments the engine then silently drops.
  //
  // Mutate the profile in place so the executor's runAgent invocation picks up
  // the locked allowedTools + mcpServer flag without needing a side-channel.
  // Backward-compat: duties without `tools:` keep their legacy Bash/gh palette.
  const declaredTools = frontmatter.tools ?? []
  if (declaredTools.length > 0) {
    const unknown = declaredTools.filter((name) => !DUTY_TOOL_PALETTE.has(name))
    if (unknown.length > 0) {
      throw new Error(
        `loadJobFromFile: duty '${slug}' declared tools not in the kody-duty palette: ${unknown.join(", ")}. ` +
          `Available: ${[...DUTY_MCP_TOOL_NAMES].join(", ")}`,
      )
    }
    // Revoke shell + Read; keep submit_state (state persistence). The LLM can
    // now only call mcp__kody-duty__<tool> + mcp__kody-submit__submit_state.
    const mcpToolNames = declaredTools.map((name) => `mcp__kody-duty__${name}`)
    profile.claudeCode.tools = [...mcpToolNames, "mcp__kody-submit__submit_state"]
    ctx.data.dutyTools = declaredTools
    ctx.data.dutyOperatorMention = mentions
    // Switch the prompt template: composePrompt picks `prompts/<mode>.md` when
    // ctx.data.promptTemplate is set. The locked template assumes no shell —
    // its instructions reference the duty MCP tools by name, not `gh`.
    ctx.data.promptTemplate = "prompts/locked.md"
    // Render the tool palette as a tight, bulletable list for the prompt.
    ctx.data.dutyToolsList = declaredTools.map((name) => `- \`${name}\``).join("\n")
  }
}

interface ParsedJob {
  title: string
  body: string
}

function parseJobFile(raw: string, slug: string): ParsedJob {
  // Strip optional YAML frontmatter (`---\n...\n---\n`) — reserved for future
  // use (e.g. cadence overrides); ignored at load time.
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
