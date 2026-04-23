/**
 * initFlow — preflight for the `init` executable.
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
import type { PreflightScript } from "../executables/types.js"
import { ensureLabels, type EnsureLabelsResult } from "../lifecycleLabels.js"
import { loadProfile } from "../profile.js"
import { listExecutables } from "../registry.js"
import { QA_GUIDE_REL_PATH } from "./loadQaGuide.js"
import { generateQaGuideTemplate, runQaDiscovery } from "./discoverQaContext.js"

type PackageManager = "pnpm" | "yarn" | "bun" | "npm"

function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm"
  if (fs.existsSync(path.join(cwd, "yarn.lock"))) return "yarn"
  if (fs.existsSync(path.join(cwd, "bun.lockb"))) return "bun"
  return "npm"
}

function qualityCommandsFor(pm: PackageManager): { typecheck: string; lint: string; testUnit: string } {
  return {
    typecheck: `${pm} tsc --noEmit`,
    lint: "",
    testUnit: `${pm} test`,
  }
}

interface OwnerRepo {
  owner: string
  repo: string
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

function makeConfig(pm: PackageManager, ownerRepo: OwnerRepo | null, defaultBranch: string): Record<string, unknown> {
  return {
    $schema: "https://raw.githubusercontent.com/aharonyaircohen/kody-engine/main/kody.config.schema.json",
    quality: qualityCommandsFor(pm),
    git: { defaultBranch },
    github: {
      owner: ownerRepo?.owner ?? "OWNER",
      repo: ownerRepo?.repo ?? "REPO",
    },
    agent: {
      model: "minimax/MiniMax-M2.7-highspeed",
    },
  }
}

const WORKFLOW_TEMPLATE = `# Drop this file at .github/workflows/kody.yml in your repo.
#
# Triggers: @kody comment on an issue or PR, or manual workflow_dispatch.
# Everything else (install deps, set up LiteLLM, run the agent, open the PR)
# is handled inside the @kody-ade/kody-engine package.
#
# Required repo secrets: at least one model provider key (e.g. MINIMAX_API_KEY,
# ANTHROPIC_API_KEY). kody reads any *_API_KEY secret automatically via
# toJSON(secrets) — no need to list them here.
#
# Recommended: KODY_TOKEN secret — a PAT or GitHub App token with repo
# scope so kody's pushes trigger downstream CI and PR-body edits succeed.

name: kody

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: "GitHub issue number"
        required: true
        type: string
  issue_comment:
    types: [created]

jobs:
  run:
    if: >-
      \${{ github.event_name == 'workflow_dispatch' ||
          (github.event_name == 'issue_comment' &&
            !github.event.issue.pull_request &&
            contains(github.event.comment.body, '@kody')) }}
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      issues: write
      pull-requests: write
      contents: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          token: \${{ secrets.KODY_TOKEN || github.token }}

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - env:
          ALL_SECRETS: \${{ toJSON(secrets) }}
        run: npx -y -p @kody-ade/kody-engine@latest kody ci --issue \${{ github.event.inputs.issue_number || github.event.issue.number }}
`

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

  const pm = detectPackageManager(cwd)
  const ownerRepo = detectOwnerRepo(cwd)
  const defaultBranch = defaultBranchFromGit(cwd)

  // 1. kody.config.json
  const configPath = path.join(cwd, "kody.config.json")
  if (fs.existsSync(configPath) && !force) {
    skipped.push("kody.config.json")
  } else {
    const cfg = makeConfig(pm, ownerRepo, defaultBranch)
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
    fs.writeFileSync(workflowPath, WORKFLOW_TEMPLATE)
    wrote.push(".github/workflows/kody.yml")
  }

  // 3. .kody/qa-guide.md — starter template for the ui-review executable.
  //    Only scaffolded when the repo looks like it has a UI (Next.js app dir,
  //    or an /app folder with page.* files). Writes CHANGE_ME credential
  //    placeholders; the maintainer fills them in and commits.
  const hasUi =
    fs.existsSync(path.join(cwd, "src/app")) ||
    fs.existsSync(path.join(cwd, "app")) ||
    fs.existsSync(path.join(cwd, "pages"))
  if (hasUi) {
    const qaGuidePath = path.join(cwd, QA_GUIDE_REL_PATH)
    if (fs.existsSync(qaGuidePath) && !force) {
      skipped.push(QA_GUIDE_REL_PATH)
    } else {
      fs.mkdirSync(path.dirname(qaGuidePath), { recursive: true })
      const discovery = runQaDiscovery(cwd)
      fs.writeFileSync(qaGuidePath, generateQaGuideTemplate(discovery))
      wrote.push(QA_GUIDE_REL_PATH)
    }
  }

  // 4. .github/workflows/kody-<name>.yml for every discovered scheduled executable.
  for (const exe of listExecutables()) {
    let profile: ReturnType<typeof loadProfile>
    try {
      profile = loadProfile(exe.profilePath)
    } catch {
      continue
    }
    if (profile.kind !== "scheduled" || !profile.schedule) continue
    const target = path.join(workflowDir, `kody-${exe.name}.yml`)
    if (fs.existsSync(target) && !force) {
      skipped.push(`.github/workflows/kody-${exe.name}.yml`)
      continue
    }
    fs.writeFileSync(target, renderScheduledWorkflow(exe.name, profile.schedule))
    wrote.push(`.github/workflows/kody-${exe.name}.yml`)
  }

  // 5. Create/update every kody-owned label declared across the executable
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

export function renderScheduledWorkflow(name: string, cron: string): string {
  return `# Scheduled kody executable: ${name}
# Generated by \`kody init\`. Regenerate with \`kody init --force\`.
# Edit the cron below or the executable's profile.json#schedule.

name: kody ${name}

on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      issues: write
      pull-requests: read
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ secrets.KODY_TOKEN || github.token }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - env:
          GH_TOKEN: \${{ secrets.KODY_TOKEN || github.token }}
        run: npx -y -p @kody-ade/kody-engine@latest kody ${name}
`
}

export const initFlow: PreflightScript = async (ctx) => {
  const force = ctx.args.force === true
  const cwd = ctx.cwd

  const { wrote, skipped, labels } = performInit(cwd, force)

  process.stdout.write("→ kody init\n")
  for (const f of wrote) process.stdout.write(`  wrote    ${f}\n`)
  for (const f of skipped) process.stdout.write(`  skipped  ${f} (already exists; pass --force to overwrite)\n`)
  if (labels) {
    if (labels.created.length > 0) {
      process.stdout.write(`  labels   ensured ${labels.created.length} lifecycle label(s)\n`)
    }
    if (labels.failed.length > 0) {
      process.stdout.write(
        `  labels   ${labels.failed.length} failed (gh auth missing? will self-heal on first run)\n`,
      )
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
