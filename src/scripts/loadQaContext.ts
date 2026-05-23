/**
 * Preflight: assemble QA context for the `qa-engineer` / `ui-review`
 * executables from dashboard-managed, per-repo stores. Replaces the legacy
 * committed `.kody/qa-guide.md` mechanism.
 *
 *   - scenarios / notes → the context entries, `.kody/context/*.md`
 *     (only entries whose `staff` list includes `qa-engineer`)
 *   - login username     → variables file `.kody/variables.json`, key LOGIN_USER
 *   - password           → secret LOGIN_PASSWORD, read from process.env
 *
 * The password is a vault secret the dashboard mirrors into the repo's GitHub
 * Actions secrets, so the engine sees it at runtime via `ALL_SECRETS`
 * (unpacked into `process.env`) — the same path as every other secret. We do
 * NOT decrypt `.kody/secrets.enc` here; CI never has KODY_MASTER_KEY (it
 * doesn't need it — secrets are mirrored, not decrypted in CI).
 *
 * Populates:
 *   ctx.data.qaLogin     — the LOGIN_USER variable ("" if unset)
 *   ctx.data.qaProfile   — concatenated `.kody/context/*.md` markdown ("" if none)
 *   ctx.data.qaAuthBlock — a complete, ready-to-insert auth instruction string
 *
 * Every step is fail-soft: missing variables, missing password, or a missing
 * profile directory are all valid states (missing everything is valid — the
 * agent then browses public routes only). This script NEVER throws.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { readKodyVariables } from "./kodyVariables.js"

const CONTEXT_DIR_REL_PATH = ".kody/context"

/** Slug of the QA staff member this preflight runs as. */
const QA_STAFF = "qa-engineer"

/** Wildcard token: a doc owned by `*` belongs to every staff member. */
const ALL_STAFF = "*"

/** Map a legacy `audience:` consumer token onto its staff-member slug. */
const LEGACY_AUDIENCE_TO_STAFF: Record<string, string> = { chat: "kody", qa: QA_STAFF }

/** Frontmatter fence: a leading `---\n…\n---` block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/** Parse an inline list (`[a, b]`) or bare scalar (`a`) into lowercased tokens. */
function parseSlugList(value: string): string[] {
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean)
}

/**
 * Read the owning `staff` list and the post-frontmatter body from a profile
 * file. Profile frontmatter is NOT job frontmatter (jobFrontmatter's parser
 * whitelists job keys and would silently drop `staff`), so we read it here.
 * The canonical format is an inline list — `staff: [kody, qa-engineer]`. A
 * legacy `audience:` list is mapped onto staff slugs (`chat` → `kody`,
 * `qa` → `qa-engineer`). An explicit empty `staff: []` is honored (unassigned
 * → owned by nobody). A file with no frontmatter defaults to `["kody"]`
 * (legacy = chat-only).
 */
function readProfileStaff(raw: string): { staff: string[]; body: string } {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { staff: ["kody"], body: raw }
  const body = raw.slice(m[0].length)
  let staff: string[] | null = null
  let legacy: string[] | null = null
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const t = line.trim()
    const c = t.indexOf(":")
    if (c < 0) continue
    const key = t.slice(0, c).trim()
    const value = t.slice(c + 1).trim()
    if (key === "staff") {
      staff = parseSlugList(value) // may be [] → unassigned
    } else if (key === "audience" || key === "for") {
      const mapped = parseSlugList(value)
        .map((tok) => LEGACY_AUDIENCE_TO_STAFF[tok])
        .filter(Boolean)
      if (mapped.length > 0) legacy = mapped
    }
  }
  return { staff: staff ?? legacy ?? ["kody"], body }
}

/**
 * Concatenate the QA-scoped `.kody/context/*.md` files into one markdown
 * block, each prefixed with a `## <filename>` heading. Only sections whose
 * `staff` list includes `qa-engineer` (or the `*` all-staff wildcard) are
 * included — chat-only sections, unassigned docs, and frontmatter-less
 * legacy files (which default to `["kody"]`) are not for QA. Returns "" if
 * the dir is absent or has no QA sections.
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
      const { staff, body } = readProfileStaff(raw)
      if (!staff.includes(QA_STAFF) && !staff.includes(ALL_STAFF)) continue
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
      `Auth: log in once at the app's login page. Username: \`${login}\` · Password: \`${password}\`. ` +
      `Re-use the session afterwards.`
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
  // LOGIN_PASSWORD is a vault secret the dashboard mirrors into the repo's
  // Actions secrets; the engine unpacks ALL_SECRETS into process.env.
  const password = process.env.LOGIN_PASSWORD ?? ""
  const authProfile = ctx.args.authProfile as string | undefined

  ctx.data.qaLogin = login
  ctx.data.qaProfile = readProfile(ctx.cwd)
  ctx.data.qaAuthBlock = composeAuthBlock(authProfile, login, password)
}
