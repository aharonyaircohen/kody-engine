/**
 * Preflight: assemble QA context for the `qa-engineer` / `ui-review`
 * implementations from dashboard-managed backend stores.
 *
 *   - scenarios / notes → the backend `context/*.md` entries
 *     (only entries whose `agent` list includes `qa-engineer`)
 *   - login username     → backend variables file `variables.json`, key LOGIN_USER
 *   - password           → secret LOGIN_PASSWORD, read from the repo vault
 *                          first, then process.env as local/dev fallback.
 *
 * Populates:
 *   ctx.data.qaLogin     — the LOGIN_USER variable ("" if unset)
 *   ctx.data.qaProfile   — concatenated backend context markdown ("" if none)
 *   ctx.data.qaAuthBlock — a complete, ready-to-insert auth instruction string
 *
 * Every step is fail-soft: missing variables, missing password, or a missing
 * profile directory are all valid states (missing everything is valid — the
 * agent then browses public routes only). This script NEVER throws.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../implementations/types.js"
import { readKodyVariables } from "./kodyVariables.js"
import { resolveRuntimeSecret } from "./runtimeSecrets.js"

const CONTEXT_DIR_REL_PATH = ".kody-engine/runtime/context"

/** Slug of the QAn agent this preflight runs as. */
const QA_AGENT = "qa-engineer"

/** Wildcard token: a doc owned by `*` belongs to every agent. */
const ALL_AGENTS = "*"

/** Map a legacy `audience:` consumer token onto its agent-member slug. */
const LEGACY_AUDIENCE_TO_AGENT: Record<string, string> = { chat: "kody", qa: QA_AGENT }

/** Frontmatter fence: a leading `---\n…\n---` block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Parse an inline list (`[a, b]`) or bare scalar (`a`) into lowercased tokens. */
function parseSlugList(value: string): string[] {
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
  return inner
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean)
}

/**
 * Read the owning `agent` list and the post-frontmatter body from a context
 * file. Context frontmatter is its own tiny format, so we parse it here.
 * The canonical format is an inline list — `agent: [kody, qa-engineer]`. A
 * legacy `audience:` list is mapped onto agent slugs (`chat` → `kody`,
 * `qa` → `qa-engineer`). An explicit empty `agent: []` is honored (unassigned
 * → owned by nobody). A file with no frontmatter defaults to `["kody"]`
 * (legacy = chat-only).
 */
function readProfileAgents(raw: string): { agent: string[]; body: string } {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { agent: ["kody"], body: raw }
  const body = raw.slice(m[0].length)
  let agent: string[] | null = null
  let legacy: string[] | null = null
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const t = line.trim()
    const c = t.indexOf(":")
    if (c < 0) continue
    const key = t.slice(0, c).trim()
    const value = t.slice(c + 1).trim()
    if (key === "agent") {
      agent = parseSlugList(value) // may be [] → unassigned
    } else if (key === "audience" || key === "for") {
      const mapped = parseSlugList(value)
        .map((tok) => LEGACY_AUDIENCE_TO_AGENT[tok])
        .filter(Boolean)
      if (mapped.length > 0) legacy = mapped
    }
  }
  return { agent: agent ?? legacy ?? ["kody"], body }
}

/**
 * Concatenate the QA-scoped backend context files from the hydrated local
 * cache into one markdown block, each prefixed with a `## <filename>` heading.
 * Only sections whose `agent` list includes `qa-engineer` (or the `*` all-agent
 * wildcard) are included — chat-only sections, unassigned docs, and
 * frontmatter-less legacy files (which default to `["kody"]`) are not for QA.
 * Returns "" if the dir is absent or has no QA sections.
 */
function readProfile(cwd: string): string {
  const dir = path.join(cwd, CONTEXT_DIR_REL_PATH)
  if (!fs.existsSync(dir)) return ""
  let entries: string[]
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
  } catch {
    return ""
  }
  const blocks: string[] = []
  for (const file of entries) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8")
      const { agent, body } = readProfileAgents(raw)
      if (!agent.includes(QA_AGENT) && !agent.includes(ALL_AGENTS)) continue
      blocks.push(`## ${file}\n\n${body.trim()}`)
    } catch {
      /* skip unreadable file */
    }
  }
  return blocks.join("\n\n")
}

function composeAuthBlock(authProfile: string | undefined, login: string, password: string): string {
  if (authProfile && authProfile.trim().length > 0) {
    return (
      `Auth: a saved Playwright \`storageState.json\` is available at \`${authProfile}\`. ` +
      `Pass it to the browser via the \`storageState\` parameter so the session starts pre-authenticated.`
    )
  }
  if (login && password) {
    return (
      `Auth: QA credentials for \`${login}\` are configured. The engine will prepare the authenticated browser ` +
      `session before the agent starts; the password is never included in agent context.`
    )
  }
  if (login) {
    return (
      `Auth: username \`${login}\` is configured but no \`LOGIN_PASSWORD\` secret was found. ` +
      `Note auth-gated surfaces as gaps.`
    )
  }
  return (
    "Auth: no QA credentials configured (set the `LOGIN_USER` variable and the `LOGIN_PASSWORD` vault secret). " +
    "Browse public routes only; note auth-gated surfaces as gaps."
  )
}

export const loadQaContext: PreflightScript = async (ctx) => {
  const vars = readKodyVariables(ctx.cwd)
  const login = vars.LOGIN_USER ?? ""
  const password = await resolveRuntimeSecret("LOGIN_PASSWORD", ctx)
  const authProfile = ctx.args.authProfile as string | undefined

  ctx.data.qaLogin = login
  ctx.data.qaPasswordSource = password.source
  if (password.warning) ctx.data.qaPasswordWarning = password.warning
  ctx.data.qaProfile = readProfile(ctx.cwd)
  ctx.data.qaAuthBlock = composeAuthBlock(authProfile, login, password.value)
}
