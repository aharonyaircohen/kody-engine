/**
 * Preflight: assemble QA context for the `qa-engineer` / `ui-review`
 * executables from dashboard-managed, per-repo stores. Replaces the legacy
 * committed `.kody/qa-guide.md` mechanism.
 *
 *   - scenarios / notes → the company profile, `.kody/profile/*.md`
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

/**
 * Concatenate every `.kody/profile/*.md` file into one markdown block, each
 * prefixed with a `## <filename>` heading. Returns "" if the directory is
 * absent or contains no readable markdown.
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
      const content = fs.readFileSync(path.join(dir, file), "utf-8")
      blocks.push(`## ${file}\n\n${content}`)
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
