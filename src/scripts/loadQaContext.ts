/**
 * Preflight: assemble QA context for the `qa-engineer` / `ui-review`
 * executables from dashboard-managed, per-repo stores. Replaces the legacy
 * committed `.kody/qa-guide.md` mechanism.
 *
 *   - scenarios / notes → the company profile, `.kody/profile/*.md`
 *     (only sections whose `audience` list includes `qa`)
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
 *   ctx.data.qaProfile   — concatenated `.kody/profile/*.md` markdown ("" if none)
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

const PROFILE_DIR_REL_PATH = ".kody/profile"

/** Frontmatter fence: a leading `---\n…\n---` block. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Read the `audience` list and the post-frontmatter body from a profile file.
 * Profile frontmatter is NOT job frontmatter (jobFrontmatter's parser
 * whitelists job keys and would silently drop `audience`), so we read it here.
 * The canonical format is an inline list — `audience: [chat, qa]` — but a bare
 * scalar (`audience: qa`) is tolerated. A file with no frontmatter, or no
 * `audience` line, defaults to `["chat"]` (legacy = chat-only).
 */
function readProfileAudience(raw: string): { audience: string[]; body: string } {
  const m = FRONTMATTER_RE.exec(raw)
  if (!m) return { audience: ["chat"], body: raw }
  const body = raw.slice(m[0].length)
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const t = line.trim()
    const c = t.indexOf(":")
    if (c < 0) continue
    if (t.slice(0, c).trim() === "audience") {
      const v = t.slice(c + 1).trim()
      const inner = v.startsWith("[") && v.endsWith("]") ? v.slice(1, -1) : v
      const audience = inner
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, "").toLowerCase())
        .filter(Boolean)
      return { audience: audience.length > 0 ? audience : ["chat"], body }
    }
  }
  return { audience: ["chat"], body }
}

/**
 * Concatenate the QA-scoped `.kody/profile/*.md` sections into one markdown
 * block, each prefixed with a `## <filename>` heading. Only sections whose
 * `audience` list includes `qa` are included — chat-only sections (and
 * frontmatter-less legacy files, which default to `["chat"]`) belong to the
 * chat prompt, not QA. Returns "" if the dir is absent or has no QA sections.
 */
function readProfile(cwd: string): string {
  const dir = path.join(cwd, PROFILE_DIR_REL_PATH)
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
      const { audience, body } = readProfileAudience(raw)
      if (!audience.includes("qa")) continue
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
