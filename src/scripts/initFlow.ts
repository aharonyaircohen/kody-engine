/**
 * initFlow — preflight for the `init` implementation.
 *
 * Scaffolds a consumer repo: writes `kody.config.json` and
 * `.github/workflows/kody.yml` if absent (or when `--force`). Detects the
 * package manager from lockfiles to pre-fill `quality.*` commands. Reads
 * repo owner/name from `git remote get-url origin` when available; leaves
 * placeholders otherwise. Sets `ctx.skipAgent = true` — init never calls
 * the agent.
 */

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import pkg from "../../package.json"
import { inferQualityCommands } from "../config.js"
import type { PreflightScript } from "../implementations/types.js"
import { type EnsureLabelsResult, ensureLabels } from "../lifecycleLabels.js"
import { loadKodyWorkflowTemplate } from "../workflow-template.js"

interface OwnerRepo {
  owner: string
  repo: string
}

// Derive the published config schema URL from this package's own
// repository.url, so a fork that republishes under its own scope points
// `kody-engine init` consumers at the fork's schema instead of the original repo.
function schemaUrlFromPkg(): string {
  const fallback = "https://raw.githubusercontent.com/aharonyaircohen/kody-engine/main/kody.config.schema.json"
  const repoUrl = (pkg as { repository?: { url?: string } }).repository?.url
  const m = repoUrl?.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/) ?? null
  if (!m) return fallback
  return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/kody.config.schema.json`
}

function detectOwnerRepo(cwd: string): OwnerRepo | null {
  let url: string
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    return null
  }
  // Match both SSH (git@github.com:owner/repo.git) and HTTPS
  // (https://github.com/owner/repo.git or .../repo).
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/) ?? null
  if (!m) return null
  return { owner: m[1]!, repo: m[2]! }
}

function makeConfig(cwd: string, ownerRepo: OwnerRepo | null, defaultBranch: string): Record<string, unknown> {
  return {
    $schema: schemaUrlFromPkg(),
    quality: inferQualityCommands(cwd),
    git: { defaultBranch },
    github: {
      owner: ownerRepo?.owner ?? "OWNER",
      repo: ownerRepo?.repo ?? "REPO",
    },
    agent: {
      model: "minimax/MiniMax-M3",
    },
  }
}

function defaultBranchFromGit(cwd: string): string {
  try {
    const ref = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    return ref.replace("refs/remotes/origin/", "")
  } catch {
    try {
      return (
        execFileSync("git", ["branch", "--show-current"], {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim() || "main"
      )
    } catch {
      return "main"
    }
  }
}

export interface InitResult {
  wrote: string[]
  skipped: string[]
  labels?: EnsureLabelsResult
}

export function performInit(cwd: string, force: boolean): InitResult {
  const wrote: string[] = []
  const skipped: string[] = []

  const ownerRepo = detectOwnerRepo(cwd)
  const defaultBranch = defaultBranchFromGit(cwd)

  // 1. kody.config.json
  const configPath = path.join(cwd, "kody.config.json")
  if (fs.existsSync(configPath) && !force) {
    skipped.push("kody.config.json")
  } else {
    const cfg = makeConfig(cwd, ownerRepo, defaultBranch)
    fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`)
    wrote.push("kody.config.json")
  }

  // 2. .github/workflows/kody.yml
  const workflowDir = path.join(cwd, ".github", "workflows")
  const workflowPath = path.join(workflowDir, "kody.yml")
  if (fs.existsSync(workflowPath) && !force) {
    skipped.push(".github/workflows/kody.yml")
  } else {
    fs.mkdirSync(workflowDir, { recursive: true })
    fs.writeFileSync(workflowPath, loadKodyWorkflowTemplate())
    wrote.push(".github/workflows/kody.yml")
  }

  // 3. Create/update every kody-owned label declared across the implementation
  //    profile set. Best-effort: if `gh` isn't installed/authenticated, this
  //    is skipped silently and setKodyLabel will lazily create the label on
  //    first use during a real flow run.
  let labels: EnsureLabelsResult | undefined
  try {
    labels = ensureLabels(cwd)
  } catch {
    labels = undefined
  }

  return { wrote, skipped, labels }
}

export const initFlow: PreflightScript = async (ctx) => {
  const force = ctx.args.force === true
  const cwd = ctx.cwd

  const { wrote, skipped, labels } = performInit(cwd, force)

  process.stdout.write("→ kody-engine init\n")
  for (const f of wrote) process.stdout.write(`  wrote    ${f}\n`)
  for (const f of skipped) process.stdout.write(`  skipped  ${f} (already exists; pass --force to overwrite)\n`)
  if (labels) {
    if (labels.created.length > 0) {
      process.stdout.write(`  labels   ensured ${labels.created.length} lifecycle label(s)\n`)
    }
    if (labels.failed.length > 0) {
      process.stdout.write(`  labels   ${labels.failed.length} failed (gh auth missing? will self-heal on first run)\n`)
    }
  }
  process.stdout.write(
    wrote.length > 0
      ? `\nDone. Edit kody.config.json to pick your model, then push the workflow file.\n`
      : `\nNothing to do. All files already present. (Use --force to overwrite.)\n`,
  )

  // Init never invokes the agent.
  ctx.skipAgent = true
  ctx.output.exitCode = 0
}
