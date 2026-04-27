/**
 * Preflight: load a file-based mission (body from disk, state from a tracked
 * repo file) into ctx.data. Mirror of `loadIssueStateComment` for the
 * file-based mission model.
 *
 * Reads the markdown body at `<missionsDir>/<slug>.md` and the mission's
 * state file at `<missionsDir>/<slug>.state.json`. Both live under the same
 * directory so they're easy to read together. Sets:
 *
 *   ctx.data.missionSlug         the slug
 *   ctx.data.missionTitle        first H1 of the body, or slug formatted
 *   ctx.data.missionIntent       the body (post-frontmatter, if any)
 *   ctx.data.missionStateJson    rendered prior state, or seed on first run
 *   ctx.data.missionState        LoadedMissionState (path, sha, state, created)
 *
 * Script args (via `with:`):
 *   missionsDir   optional — default ".kody/missions"
 *   slugArg       optional — name of the CLI input holding the slug (default "mission")
 */

import * as fs from "node:fs"
import * as path from "node:path"
import type { PreflightScript } from "../executables/types.js"
import { loadMissionState, stateFilePath } from "./missionStateFile.js"

export const loadMissionFromFile: PreflightScript = async (ctx, _profile, args) => {
  const missionsDir = String(args?.missionsDir ?? ".kody/missions")
  const slugArg = String(args?.slugArg ?? "mission")
  const slug = String(ctx.args[slugArg] ?? "").trim()
  if (!slug) {
    throw new Error(`loadMissionFromFile: ctx.args.${slugArg} must be a non-empty slug`)
  }

  const owner = ctx.config.github.owner
  const repo = ctx.config.github.repo
  if (!owner || !repo) {
    throw new Error("loadMissionFromFile: ctx.config.github.owner/repo must be set")
  }

  const absPath = path.join(ctx.cwd, missionsDir, `${slug}.md`)
  if (!fs.existsSync(absPath)) {
    throw new Error(`loadMissionFromFile: mission file not found: ${absPath}`)
  }
  const raw = fs.readFileSync(absPath, "utf-8")
  const { title, body } = parseMissionFile(raw, slug)

  // Load state via the contents API (default GITHUB_TOKEN is sufficient).
  // Returns a seed envelope when the file doesn't exist yet (first tick).
  const loaded = loadMissionState(owner, repo, stateFilePath(missionsDir, slug), ctx.cwd)

  ctx.data.missionSlug = slug
  ctx.data.missionTitle = title
  ctx.data.missionIntent = body
  ctx.data.missionState = loaded
  ctx.data.missionStateJson = JSON.stringify(loaded.state, null, 2)
}

interface ParsedMission {
  title: string
  body: string
}

function parseMissionFile(raw: string, slug: string): ParsedMission {
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
