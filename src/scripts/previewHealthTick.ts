/**
 * Deterministic preview-health tick.
 *
 * Scans open PRs, chooses one repair per PR in priority order
 * (resolve > fix-ci > sync), dispatches policy-auto / graduated repairs,
 * posts inert recommendations for non-graduated repairs, and proposes the
 * next file-backed duty state for writeJobStateFile.
 */
import type { PreflightScript, Profile } from "../executables/types.js"
import { gh } from "../issue.js"
import type { StateEnvelope } from "./issueStateComment.js"
import { resolveBackend } from "./jobState/index.js"

const DECISIONS_LABEL = "kody:cto-decisions"
const LEDGER_START = "<!-- kody-cto-decisions:start -->"
const LEDGER_END = "<!-- kody-cto-decisions:end -->"
const VERBS = ["fix-ci", "sync", "resolve"] as const
const AUTO_VERBS = new Set<RepairVerb>(["resolve"])
const MAX_ACTIONS_PER_TICK = 5
const FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"])
const RUNNING_STATUSES = new Set(["IN_PROGRESS", "QUEUED"])
const STALE_THRESHOLD = 10

type RepairVerb = (typeof VERBS)[number]
type Repair = RepairVerb | "defer"

interface PrCheck {
  conclusion?: string | null
  status?: string | null
}

interface PullRequest {
  number: number
  title?: string
  headRefName: string
  headRefOid: string
  baseRefName: string
  isDraft?: boolean
  mergeable?: string | null
  statusCheckRollup?: PrCheck[]
  updatedAt?: string
}

interface TrackedPr {
  fp?: string
  stage?: string
  lastActAt?: string
}

type TrackedPrs = Record<string, TrackedPr>

function log(message: string): void {
  process.stderr.write(`[preview-health] ${message}\n`)
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function repoSlug(configRepo: { owner?: string; repo?: string } | undefined): string {
  if (configRepo?.owner && configRepo.repo) return `${configRepo.owner}/${configRepo.repo}`
  return process.env.GITHUB_REPOSITORY?.trim() ?? ""
}

function operatorHandle(profile: Profile): string | null {
  const [operator] = profile.mentions ?? []
  return typeof operator === "string" && operator.trim().length > 0 ? operator.trim() : null
}

function readLedgerModes(cwd: string): Record<RepairVerb, "ask" | "auto"> {
  const modes = Object.fromEntries(VERBS.map((verb) => [verb, "ask"])) as Record<RepairVerb, "ask" | "auto">
  let issues: Array<{ number?: number; body?: string }> = []
  try {
    issues = parseJson(
      gh(["issue", "list", "--state", "open", "--label", DECISIONS_LABEL, "--limit", "5", "--json", "number,body"], {
        cwd,
      }) || "[]",
      [],
    )
  } catch (err) {
    log(`ledger read failed (treating all verbs as ask): ${err instanceof Error ? err.message : String(err)}`)
    return modes
  }

  if (issues.length === 0) return modes
  const lowest = [...issues].sort(
    (a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER),
  )[0]
  const body = lowest?.body ?? ""
  if (!body.includes(LEDGER_START) || !body.includes(LEDGER_END)) return modes

  const inner = body.split(LEDGER_START, 2)[1]?.split(LEDGER_END, 1)[0] ?? ""
  const match = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/m.exec(inner)
  if (!match) return modes

  const ledger = parseJson<Record<string, unknown> | null>(match[1] ?? "", null)
  const staff = asRecord(asRecord(ledger)?.staff)
  const cto = asRecord(staff?.cto)
  for (const verb of VERBS) {
    if (asRecord(cto?.[verb])?.mode === "auto") modes[verb] = "auto"
  }
  return modes
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function ciFailing(rollup: PrCheck[] | undefined): boolean {
  if (!Array.isArray(rollup)) return false
  const hasFail = rollup.some((check) => FAIL_CONCLUSIONS.has(String(check.conclusion ?? "")))
  const anyRunning = rollup.some((check) => RUNNING_STATUSES.has(String(check.status ?? "")))
  return hasFail && !anyRunning
}

function behindBy(cwd: string, slug: string, base: string, head: string): number {
  try {
    const raw = gh(["api", `repos/${slug}/compare/${base}...${head}`, "--jq", ".behind_by"], { cwd })
    return Number.parseInt(raw.trim(), 10) || 0
  } catch (err) {
    log(`compare ${base}...${head} failed: ${err instanceof Error ? err.message : String(err)}`)
    return 0
  }
}

function refreshMergeable(cwd: string, prNumber: number): string {
  try {
    const raw = gh(["pr", "view", String(prNumber), "--json", "mergeable", "--jq", ".mergeable"], { cwd })
    return raw.trim()
  } catch (err) {
    log(`refresh mergeable #${prNumber} failed: ${err instanceof Error ? err.message : String(err)}`)
    return "UNKNOWN"
  }
}

function detectRepair(cwd: string, slug: string, pr: PullRequest): { verb: Repair; reason: string } | null {
  let mergeable = pr.mergeable ?? "UNKNOWN"
  if (mergeable === "UNKNOWN") mergeable = refreshMergeable(cwd, pr.number)
  if (mergeable === "UNKNOWN") {
    return { verb: "defer", reason: `PR #${pr.number} mergeability still UNKNOWN; retry next tick.` }
  }
  if (mergeable === "CONFLICTING")
    return { verb: "resolve", reason: `PR #${pr.number} merge conflicts \`${pr.baseRefName}\`.` }
  if (ciFailing(pr.statusCheckRollup)) return { verb: "fix-ci", reason: `PR #${pr.number} has failing CI checks.` }
  const drift = behindBy(cwd, slug, pr.baseRefName, pr.headRefName)
  if (drift > STALE_THRESHOLD) {
    return { verb: "sync", reason: `PR #${pr.number}'s branch is ${drift} commits behind \`${pr.baseRefName}\`.` }
  }
  return null
}

function postComment(cwd: string, prNumber: number, body: string): boolean {
  if (process.env.KODY_DRY_RUN === "1") {
    log(`[dry-run] would comment on #${prNumber}: ${body.split("\n")[0]}`)
    return true
  }
  try {
    gh(["pr", "comment", String(prNumber), "--body", body], { cwd })
    return true
  } catch (err) {
    log(`comment failed on #${prNumber}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

function recommend(cwd: string, prNumber: number, verb: RepairVerb, reason: string, operator: string | null): boolean {
  const mention = operator ? `@${operator} ` : ""
  return postComment(
    cwd,
    prNumber,
    `${mention}🧭 **CTO recommendation** — \`${verb}\`\n\n` +
      `${reason} Recommended action: \`${verb}\` for PR #${prNumber}.\n\n` +
      "_Confirm in the dashboard inbox or run the action manually. The CTO will not act on its own._",
  )
}

function autoRun(cwd: string, prNumber: number, verb: RepairVerb, reason: string): boolean {
  if (process.env.KODY_DRY_RUN === "1") {
    log(`[dry-run] would dispatch kody.yml executable=${verb} issue_number=${prNumber}`)
  } else {
    try {
      gh(["workflow", "run", "kody.yml", "-f", `executable=${verb}`, "-f", `issue_number=${prNumber}`], { cwd })
    } catch (err) {
      log(`workflow_dispatch failed #${prNumber} (${verb}): ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  const autoReason = AUTO_VERBS.has(verb)
    ? "Policy: preview-health auto-runs `resolve` for merge conflicts."
    : `Graduated: operator approved \`${verb}\` repeatedly. A **Reject** on any \`${verb}\` returns me asking.`
  return postComment(
    cwd,
    prNumber,
    `🧭 **CTO auto-ran** — \`${verb}\`\n\n` +
      `Dispatched \`${verb}\` on PR #${prNumber} via workflow_dispatch (${reason}). ${autoReason}`,
  )
}

function printRow(pr: string | number, verb: string, fp: string, action: string, note: string): void {
  process.stdout.write(`| #${pr} | ${verb} | ${fp} | ${action} | ${note} |\n`)
}

export const previewHealthTick: PreflightScript = async (ctx, profile: Profile, args) => {
  ctx.skipAgent = true

  const jobsDir = String(args?.jobsDir ?? ".kody/duties")
  const slug = profile.name
  const backend = resolveBackend({ config: ctx.config, cwd: ctx.cwd, jobsDir })
  const loaded = await backend.load(slug)
  ctx.data.jobSlug = slug
  ctx.data.jobState = loaded

  const slugRepo = repoSlug(ctx.config.github)
  if (!slugRepo) {
    ctx.output.exitCode = 1
    ctx.output.reason = "previewHealthTick: could not resolve owner/repo"
    return
  }

  const modes = readLedgerModes(ctx.cwd)
  const operator = operatorHandle(profile)
  let prs: PullRequest[] = []
  try {
    prs = parseJson(
      gh(
        [
          "pr",
          "list",
          "--state",
          "open",
          "--limit",
          "100",
          "--json",
          "number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,updatedAt",
        ],
        { cwd: ctx.cwd },
      ) || "[]",
      [],
    )
  } catch (err) {
    ctx.output.exitCode = 1
    ctx.output.reason = `previewHealthTick: pr list failed: ${err instanceof Error ? err.message : String(err)}`
    return
  }

  const prior = asRecord(loaded.state.data?.prs) ?? {}
  const openNumbers = new Set(prs.map((pr) => String(pr.number)))
  const nextPrs: TrackedPrs = {}
  for (const [key, value] of Object.entries(prior)) {
    if (openNumbers.has(key) && asRecord(value)) nextPrs[key] = value as TrackedPr
  }

  process.stdout.write("| PR | verb | fingerprint | action | note |\n")
  process.stdout.write("|----|------|-------------|--------|------|\n")

  const priority: Record<RepairVerb, number> = { resolve: 0, "fix-ci": 1, sync: 2 }
  const queue: Array<{ priority: number; num: number; pr: PullRequest; verb: RepairVerb; reason: string }> = []

  for (const pr of prs) {
    if (pr.isDraft) {
      printRow(pr.number, "—", "—", "skip", "draft")
      continue
    }
    const repair = detectRepair(ctx.cwd, slugRepo, pr)
    if (!repair) {
      printRow(pr.number, "—", "—", "skip", "healthy")
      continue
    }
    if (repair.verb === "defer") {
      printRow(pr.number, "—", "—", "defer", "mergeable=UNKNOWN")
      continue
    }
    queue.push({ priority: priority[repair.verb], num: pr.number, pr, verb: repair.verb, reason: repair.reason })
  }

  let actionsTaken = 0
  for (const item of queue.sort((a, b) => a.priority - b.priority || a.num - b.num)) {
    const key = String(item.num)
    const fp = `${item.verb}|${item.pr.headRefOid ?? ""}`
    const graduated = AUTO_VERBS.has(item.verb) || modes[item.verb] === "auto"
    const intendedStage = graduated ? `${item.verb}-auto` : `${item.verb}-recommended`
    const existing = nextPrs[key]

    if (existing?.fp === fp && (existing.stage === intendedStage || existing.stage === "dismissed")) {
      printRow(item.num, item.verb, fp.slice(0, 24), "skip", "dedup (unchanged)")
      continue
    }
    if (actionsTaken >= MAX_ACTIONS_PER_TICK) {
      printRow(item.num, item.verb, fp.slice(0, 24), "defer", `per-tick cap (${MAX_ACTIONS_PER_TICK})`)
      continue
    }

    const ok = graduated
      ? autoRun(ctx.cwd, item.num, item.verb, item.reason)
      : recommend(ctx.cwd, item.num, item.verb, item.reason, operator)
    const stage = intendedStage
    const action = graduated ? (ok ? "auto-ran" : "auto-failed") : ok ? "recommended" : "recommend-failed"
    if (ok) {
      actionsTaken += 1
      nextPrs[key] = { fp, stage, lastActAt: nowIso() }
    }
    printRow(item.num, item.verb, fp.slice(0, 24), action, graduated ? "auto" : "advisory")
  }

  log(`tick complete: ${actionsTaken} action(s), ${Object.keys(nextPrs).length} tracked PR(s)`)
  const nextState: StateEnvelope = {
    version: 1,
    rev: (loaded.state.rev ?? 0) + 1,
    cursor: "idle",
    data: { prs: nextPrs },
    done: false,
  }
  ctx.data.nextJobState = nextState
  ctx.output.exitCode = 0
}
