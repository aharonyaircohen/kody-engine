import pkg from "../package.json"
import { runChat } from "./chat-cli.js"
import { runExecutable } from "./executor.js"
import { runCi } from "./kody-cli.js"
import { hasExecutable, listExecutables, parseGenericFlags } from "./registry.js"

interface ParsedArgs {
  command: "ci" | "chat" | "help" | "version" | "__executable__"
  executableName?: string
  cliArgs?: Record<string, unknown>
  cwd?: string
  verbose?: boolean
  quiet?: boolean
  errors: string[]
  ciArgv?: string[]
  chatArgv?: string[]
}

const HELP_TEXT = `kody — single-session autonomous engineer

Usage:
  kody run     --issue <N> [--cwd <path>] [--verbose|--quiet]
  kody fix     --pr    <N> [--feedback "..."] [--cwd <path>] [--verbose|--quiet]
  kody fix-ci  --pr    <N> [--run-id <ID>]    [--cwd <path>] [--verbose|--quiet]
  kody resolve --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody review  --pr    <N>                    [--cwd <path>] [--verbose|--quiet]
  kody <other>                                [--cwd <path>] [--verbose|--quiet]
  kody ci      --issue <N> [preflight flags — see: kody ci --help]
  kody chat    [chat flags — see: kody chat --help]
  kody help
  kody version

Each top-level command (run, fix, fix-ci, resolve, review, …) is a discovered
executable under \`src/executables/<name>/profile.json\`. Drop in a new
directory to add a new command.

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
  if (cmd === "chat") {
    return { ...result, command: "chat", chatArgv: argv.slice(1) }
  }

  // Every other top-level command is a discovered executable (run, fix, fix-ci,
  // resolve, review, plan, orchestrator, init, release, watch-*, …).
  if (hasExecutable(cmd)) {
    result.command = "__executable__"
    result.executableName = cmd
    result.cliArgs = parseGenericFlags(argv.slice(1))
    if (typeof result.cliArgs.cwd === "string") result.cwd = result.cliArgs.cwd
    if (result.cliArgs.verbose === true) result.verbose = true
    if (result.cliArgs.quiet === true) result.quiet = true
    return result
  }

  const discovered = listExecutables().map((e) => e.name)
  const available = ["ci", "help", "version", ...discovered]
  result.errors.push(`unknown command: ${cmd} (available: ${available.join(", ")})`)
  return result
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
    process.stdout.write(`kody ${pkg.version}\n`)
    return 0
  }
  if (args.command === "ci") {
    try {
      return await runCi(args.ciArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }
  if (args.command === "chat") {
    try {
      return await runChat(args.chatArgv ?? [])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[kody] fatal: ${msg}\n`)
      if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
      return 99
    }
  }

  const cwd = args.cwd ?? process.cwd()

  // init runs BEFORE a kody.config.json exists — tell the executor to skip config load.
  const configlessCommands = new Set(["init"])
  const skipConfig = configlessCommands.has(args.executableName ?? "")

  try {
    const result = await runExecutable(args.executableName!, {
      cliArgs: args.cliArgs ?? {},
      cwd,
      skipConfig,
      verbose: args.verbose,
      quiet: args.quiet,
    })
    if (result.exitCode !== 0 && result.reason) {
      process.stderr.write(`error: ${result.reason}\n`)
    }
    return result.exitCode
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[kody] ${args.executableName} crashed: ${msg}\n`)
    if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`)
    process.stdout.write(`PR_URL=FAILED: ${args.executableName} crashed: ${msg}\n`)
    return 99
  }
}
