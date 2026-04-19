import pkg from "../package.json"
import type { Kody2Config } from "./config.js"
import { loadConfig } from "./config.js"
import { runExecutable } from "./executor.js"
import { runCi } from "./kody2-cli.js"
import { hasExecutable, listExecutables, parseGenericFlags } from "./registry.js"

interface ParsedArgs {
  command: "run" | "fix" | "fix-ci" | "resolve" | "ci" | "help" | "version" | "__executable__"
  executableName?: string
  cliArgs?: Record<string, unknown>
  issueNumber?: number
  prNumber?: number
  feedback?: string
  runId?: string
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  dryRun?: boolean
  errors: string[]
  ciArgv?: string[]
}

const HELP_TEXT = `kody2 — single-session autonomous engineer

Usage:
  kody2 run     --issue <N> [--cwd <path>] [--verbose|--quiet] [--dry-run]
  kody2 ci      --issue <N> [preflight flags — see: kody2 ci --help]
  kody2 fix     --pr    <N> [--feedback "..."] [--cwd <path>] [--verbose|--quiet]
  kody2 fix-ci  --pr    <N> [--run-id <ID>]    [--cwd <path>] [--verbose|--quiet]
  kody2 resolve --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody2 help
  kody2 version

All commands dispatch to the Build executable with a specific mode. The
executable is defined by \`src/executables/build/profile.json\`.

Exit codes:
  0   success (PR opened, verify passed — or resolve produced a merge commit)
  1   agent reported FAILED (draft PR opened)
  2   verify failed (draft PR opened) — skipped in resolve mode
  3   no commits to ship (also the resolve clean-merge short-circuit)
  4   PR creation failed
  5   uncommitted changes on target branch
  64  invalid CLI args
  99  wrapper crashed
`

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: "help", errors: [] }
  if (argv.length === 0) return result

  const cmd = argv[0]!
  if (cmd === "help" || cmd === "--help" || cmd === "-h") return { ...result, command: "help" }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return { ...result, command: "version" }
  if (cmd === "ci") {
    return { ...result, command: "ci", ciArgv: argv.slice(1) }
  }

  if (cmd === "run" || cmd === "fix" || cmd === "fix-ci" || cmd === "resolve") {
    result.command = cmd
    parseCommandArgs(cmd, argv.slice(1), result)
    return result
  }

  // Fall through to registry: auto-discovered executables (init, review, watch-*, …).
  if (hasExecutable(cmd)) {
    result.command = "__executable__"
    result.executableName = cmd
    result.cliArgs = parseGenericFlags(argv.slice(1))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
  }

  const discovered = listExecutables()
    .map((e) => e.name)
    .filter((n) => n !== "build") // build is exposed via run/fix/fix-ci/resolve, not directly
  const available = ["run", "fix", "fix-ci", "resolve", "ci", "help", "version", ...discovered]
  result.errors.push(`unknown command: ${cmd} (available: ${available.join(", ")})`)
  return result
}

function parseCommandArgs(cmd: ParsedArgs["command"], rest: string[], result: ParsedArgs): void {
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--issue") {
      const n = parseInt(rest[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--issue requires a positive integer")
      else result.issueNumber = n
    } else if (arg === "--pr") {
      const n = parseInt(rest[++i] ?? "", 10)
      if (Number.isNaN(n) || n <= 0) result.errors.push("--pr requires a positive integer")
      else result.prNumber = n
    } else if (arg === "--feedback") {
      result.feedback = rest[++i]
    } else if (arg === "--run-id") {
      result.runId = rest[++i]
    } else if (arg === "--cwd") {
      result.cwd = rest[++i]
    } else if (arg === "--verbose") result.verbose = true
    else if (arg === "--quiet") result.quiet = true
    else if (arg === "--dry-run") result.dryRun = true
    else result.errors.push(`unknown arg: ${arg}`)
  }

  if (cmd === "run" && !result.issueNumber) result.errors.push("--issue <N> is required for run")
  if (cmd === "fix" && !result.prNumber) result.errors.push("--pr <N> is required for fix")
  if (cmd === "fix-ci" && !result.prNumber) result.errors.push("--pr <N> is required for fix-ci")
  if (cmd === "resolve" && !result.prNumber) result.errors.push("--pr <N> is required for resolve")
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)

  if (args.errors.length > 0) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`)
    process.stderr.write(`\n${HELP_TEXT}`)
    return 64
  }
  if (args.command === "help") {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (args.command === "version") {
    process.stdout.write(`kody2 ${pkg.version}\n`)
    return 0
  }
  if (args.command === "ci") {
    try {
      return await runCi(args.ciArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody2] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }

  const cwd = args.cwd ?? process.cwd()

  // init runs BEFORE a kody.config.json exists — bypass config load for it.
  const configlessCommands = new Set(["init"])
  const needsConfig = !(args.command === "__executable__" && configlessCommands.has(args.executableName ?? ""))

  let config: Kody2Config
  if (needsConfig) {
    try {
      config = loadConfig(cwd)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody2] config error: ${msg}\n`)
      process.stdout.write(`PR_URL=FAILED: config error: ${msg}\n`)
      return 99
    }
  } else {
    // Placeholder config for configless executables. The executor still requires
    // a Kody2Config shape but these executables' scripts must not read from it.
    config = {
      quality: { typecheck: "", lint: "", testUnit: "" },
      git: { defaultBranch: "main" },
      github: { owner: "", repo: "" },
      agent: { model: "claude/claude-haiku-4-5-20251001" },
    }
  }

  // Auto-discovered executables (e.g. init, review, watch-*).
  if (args.command === "__executable__") {
    try {
      const result = await runExecutable(args.executableName!, {
        cliArgs: args.cliArgs ?? {},
        cwd,
        config,
        verbose: args.verbose,
        quiet: args.quiet,
      })
      return result.exitCode
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody2] ${args.executableName} crashed: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      process.stdout.write(`PR_URL=FAILED: ${args.executableName} crashed: ${msg}\n`)
      return 99
    }
  }

  // The four pipeline commands (run/fix/fix-ci/resolve) dispatch to the Build executable.
  const cliArgs: Record<string, unknown> = { mode: args.command }
  if (args.issueNumber !== undefined) cliArgs.issue = args.issueNumber
  if (args.prNumber !== undefined) cliArgs.pr = args.prNumber
  if (args.feedback !== undefined) cliArgs.feedback = args.feedback
  if (args.runId !== undefined) cliArgs.runId = args.runId

  try {
    const result = await runExecutable("build", {
      cliArgs,
      cwd,
      config,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    return result.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody2] wrapper crashed: ${msg}\n`)
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
    process.stdout.write(`PR_URL=FAILED: wrapper crashed: ${msg}\n`)
    return 99
  }
}
