/**
 * Postflight: evaluate risk gates on committed changes and halt flow
 * progression when a gate trips without human approval.
 *
 * Gates inspect `ctx.data.changedFiles` (set by commitAndPush) and the
 * current diff stats against the base branch. Each tripped gate produces
 * a Violation; a Violation is "acknowledged" iff the target issue/PR
 * carries `kody-approve:<gate>` (per-gate) or — for soft gates — the
 * wildcard `kody-approve:all`. Hard gates (e.g. `secrets`) require the
 * specific per-gate label.
 *
 * When any violation is pending, the script:
 *   - sets `ctx.data.riskGate.decision = "halt"`,
 *   - applies the `kody:gated` lifecycle label (mutex with `kody:running`),
 *   - lazy-creates the per-gate `kody-approve:<name>` labels,
 *   - posts an advisory comment explaining how to approve and resume.
 *
 * Downstream scripts that should NOT run when gated (e.g. `advanceFlow`)
 * guard themselves in the profile:
 *   { "script": "advanceFlow", "runWhen": { "data.riskGate.decision": "allow" } }
 *
 * Approval model matches the "GitHub is the durable store" design: a
 * gated flow is a replay, not a live resume. The branch + commits remain
 * on GitHub; the approval label unlocks the gate on the next trigger.
 */

import { execFileSync } from "node:child_process"
import type { PostflightScript } from "../executables/types.js"
import {
  gh,
  postIssueComment as ghPostIssueComment,
  postPrReviewComment as ghPostPrReviewComment,
} from "../issue.js"
import { getIssueLabels, setKodyLabel } from "../lifecycleLabels.js"

export interface Violation {
  name: GateName
  severity: "soft" | "hard"
  reason: string
}

export type GateName = "secrets" | "workflow-edit" | "large-diff" | "dep-change" | "test-deletion"

const ALL_GATES: GateName[] = ["secrets", "workflow-edit", "large-diff", "dep-change", "test-deletion"]
const HARD_GATES: Set<GateName> = new Set(["secrets"])
const APPROVE_ALL = "kody-approve:all"
const GATED_LABEL = "kody:gated"
const DEFAULT_MAX_FILES = 20
const DEFAULT_MAX_DELETIONS = 500

export const riskGate: PostflightScript = async (ctx, profile, _agent, args) => {
  // Evaluate the FULL branch diff vs. base — not just the latest commit.
  // On replay (nothing new to commit this run), the branch still carries the
  // previously-gated changes and must re-trip the gate, so only an approval
  // label can unblock progression.
  const changedFiles = collectBranchChangedFiles(ctx)
  const gatesToRun = parseGates(args?.gates)
  const violations = evaluateGates(ctx, profile.name, changedFiles, gatesToRun, args)

  if (violations.length === 0) {
    ctx.data.riskGate = { violations: [], pending: [], decision: "allow" }
    return
  }

  const targetType = ctx.data.commentTargetType as "issue" | "pr" | undefined
  const targetNumber = Number(ctx.data.commentTargetNumber ?? 0)
  // Read labels from BOTH the current target AND the originating issue (if
  // this is a PR-side primitive like fix) so an approval on either surface is
  // recognized. Users `@kody2 approve` on whichever they happen to be reading.
  const labels = collectApprovalLabels(ctx, targetType, targetNumber)
  const approveAll = labels.includes(APPROVE_ALL)
  const pending = violations.filter((v) => !isApproved(v, labels, approveAll))

  ctx.data.riskGate = {
    violations,
    pending,
    decision: pending.length === 0 ? "allow" : "halt",
  }

  if (pending.length === 0 || !targetType || targetNumber <= 0) return

  // Pre-create each per-gate approve label so the user can apply it via
  // `gh issue edit --add-label` or the GitHub web UI without a chicken-and-egg.
  for (const v of pending) {
    ensureApproveLabel(v.name, ctx.cwd)
  }

  try {
    setKodyLabel(
      targetNumber,
      {
        label: GATED_LABEL,
        color: "fbca04",
        description: "kody2: awaiting human approval of risk gate(s)",
      },
      ctx.cwd,
    )
  } catch {
    /* best effort */
  }

  const compareUrl = computeCompareUrl(ctx)
  const body = formatAdvisory(pending, compareUrl)
  try {
    if (targetType === "issue") ghPostIssueComment(targetNumber, body, ctx.cwd)
    else ghPostPrReviewComment(targetNumber, body, ctx.cwd)
  } catch {
    /* best effort */
  }

  if (!ctx.output.reason) {
    ctx.output.reason = `risk gate halt: ${pending.map((p) => p.name).join(", ")}`
  }
}

function evaluateGates(
  ctx: { cwd: string; config: { git: { defaultBranch: string } } },
  profileName: string,
  changedFiles: string[],
  gatesToRun: GateName[],
  args: Record<string, unknown> | undefined,
): Violation[] {
  const violations: Violation[] = []

  if (gatesToRun.includes("secrets")) {
    const hits = changedFiles.filter(isSecretPath)
    if (hits.length > 0) {
      violations.push({
        name: "secrets",
        severity: "hard",
        reason: `secret/credential files touched: ${preview(hits)}`,
      })
    }
  }

  if (gatesToRun.includes("workflow-edit")) {
    const hits = changedFiles.filter((f) => f.startsWith(".github/workflows/"))
    if (hits.length > 0) {
      violations.push({
        name: "workflow-edit",
        severity: "soft",
        reason: `CI workflow files modified: ${preview(hits)}`,
      })
    }
  }

  if (gatesToRun.includes("large-diff")) {
    const maxFiles = toPositiveInt(args?.maxFiles, DEFAULT_MAX_FILES)
    const maxDeletions = toPositiveInt(args?.maxDeletions, DEFAULT_MAX_DELETIONS)
    if (changedFiles.length > maxFiles) {
      violations.push({
        name: "large-diff",
        severity: "soft",
        reason: `${changedFiles.length} files changed (threshold: ${maxFiles})`,
      })
    } else {
      const stats = computeDiffStats(ctx)
      if (stats && stats.deletions > maxDeletions) {
        violations.push({
          name: "large-diff",
          severity: "soft",
          reason: `${stats.deletions} lines deleted (threshold: ${maxDeletions})`,
        })
      }
    }
  }

  if (gatesToRun.includes("dep-change") && profileName !== "chore") {
    const hits = changedFiles.filter(isDepFile)
    if (hits.length > 0) {
      violations.push({
        name: "dep-change",
        severity: "soft",
        reason: `dependency/lockfile changes outside a chore flow: ${preview(hits)}`,
      })
    }
  }

  if (gatesToRun.includes("test-deletion")) {
    const deleted = listDeletedFilesInHeadCommit(ctx.cwd).filter(isTestFile)
    if (deleted.length > 0) {
      violations.push({
        name: "test-deletion",
        severity: "soft",
        reason: `test files deleted: ${preview(deleted)}`,
      })
    }
  }

  return violations
}

function collectApprovalLabels(
  ctx: { cwd: string; data: Record<string, unknown> },
  targetType: "issue" | "pr" | undefined,
  targetNumber: number,
): string[] {
  const seen = new Set<string>()
  if (targetNumber > 0) {
    for (const l of getIssueLabels(targetNumber, ctx.cwd)) seen.add(l)
  }
  // If on a PR, also check the originating issue (flow state knows it).
  if (targetType === "pr") {
    const state = ctx.data.taskState as { flow?: { issueNumber?: number } } | undefined
    const issueNum = state?.flow?.issueNumber
    if (typeof issueNum === "number" && issueNum > 0 && issueNum !== targetNumber) {
      for (const l of getIssueLabels(issueNum, ctx.cwd)) seen.add(l)
    }
  }
  return [...seen]
}

function isApproved(v: Violation, labels: string[], approveAll: boolean): boolean {
  if (labels.includes(`kody-approve:${v.name}`)) return true
  if (!HARD_GATES.has(v.name) && approveAll) return true
  return false
}

function parseGates(spec: unknown): GateName[] {
  if (spec === undefined || spec === null || spec === "") return ALL_GATES
  const list = String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const valid = ALL_GATES as string[]
  const matched = list.filter((n) => valid.includes(n)) as GateName[]
  return matched.length > 0 ? matched : ALL_GATES
}

function toPositiveInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function preview(list: string[], max = 5): string {
  if (list.length <= max) return list.join(", ")
  return `${list.slice(0, max).join(", ")} (+${list.length - max} more)`
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)(\.|$)/i,
  /credentials?(\.|\/|$)/i,
  /(^|\/)(private|secret)[^/]*\.json$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
]

function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(p))
}

const DEP_FILES: Set<string> = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "requirements.txt",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
])

function isDepFile(p: string): boolean {
  return DEP_FILES.has(p.split("/").pop() ?? "")
}

function isTestFile(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[a-z0-9]+$/i.test(p)
}

function collectBranchChangedFiles(ctx: {
  cwd: string
  data: Record<string, unknown>
  config: { git: { defaultBranch: string } }
}): string[] {
  const base = ctx.config.git.defaultBranch
  for (const ref of [`origin/${base}...HEAD`, `${base}...HEAD`]) {
    try {
      const out = execFileSync("git", ["diff", "--name-only", ref], {
        cwd: ctx.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      const files = out.split("\n").map((s) => s.trim()).filter(Boolean)
      if (files.length > 0) return files
    } catch {
      /* try next ref */
    }
  }
  // Fallback for contexts where git diff against base isn't available
  // (e.g. unit tests, non-git cwd): use what commitAndPush already gathered.
  return (ctx.data.changedFiles as string[] | undefined) ?? []
}

function computeDiffStats(ctx: {
  cwd: string
  config: { git: { defaultBranch: string } }
}): { insertions: number; deletions: number } | null {
  const base = ctx.config.git.defaultBranch
  for (const ref of [`origin/${base}...HEAD`, `${base}...HEAD`]) {
    try {
      const out = execFileSync("git", ["diff", "--shortstat", ref], {
        cwd: ctx.cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      if (out) return parseShortstat(out)
    } catch {
      /* try next ref */
    }
  }
  return null
}

function parseShortstat(s: string): { insertions: number; deletions: number } {
  const ins = /(\d+)\s+insertions?/.exec(s)
  const del = /(\d+)\s+deletions?/.exec(s)
  return {
    insertions: ins ? parseInt(ins[1]!, 10) : 0,
    deletions: del ? parseInt(del[1]!, 10) : 0,
  }
}

function listDeletedFilesInHeadCommit(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["show", "--name-status", "--pretty=format:", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    })
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("D\t"))
      .map((l) => l.slice(2).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function ensureApproveLabel(gate: GateName, cwd: string): void {
  try {
    gh(
      [
        "label",
        "create",
        `kody-approve:${gate}`,
        "--force",
        "--color",
        "0e8a16",
        "--description",
        `kody2: approve the ${gate} risk gate and resume the flow`,
      ],
      { cwd },
    )
  } catch {
    /* best effort — user can also create via the GitHub UI */
  }
}

function formatAdvisory(pending: Violation[], compareUrl: string | null): string {
  const lines: string[] = []
  lines.push("⏸️ **kody2 risk gate halted the flow.**")
  lines.push("")
  lines.push("The branch was pushed but **no PR was opened** — waiting for human approval:")
  lines.push("")
  for (const v of pending) {
    lines.push(`- **\`${v.name}\`** _(${v.severity})_ — ${v.reason}`)
  }
  lines.push("")
  if (compareUrl) {
    lines.push(`📎 Review the branch diff: ${compareUrl}`)
    lines.push("")
  }
  lines.push("**To approve and resume**, post a comment:")
  lines.push("")
  lines.push("> `@kody2 approve`")
  lines.push("")
  lines.push(
    "kody2 will acknowledge all currently-pending gates (soft **and** hard), open the PR, and continue the flow from this checkpoint. No re-running the agent.",
  )
  return lines.join("\n")
}

function computeCompareUrl(ctx: {
  cwd: string
  config: { git: { defaultBranch: string }; github?: { owner?: string; repo?: string } }
  data: Record<string, unknown>
}): string | null {
  const branch = ctx.data.branch as string | undefined
  if (!branch) return null
  const owner = ctx.config.github?.owner
  const repo = ctx.config.github?.repo
  if (!owner || !repo) return null
  const base = ctx.config.git.defaultBranch
  return `https://github.com/${owner}/${repo}/compare/${base}...${branch}`
}
