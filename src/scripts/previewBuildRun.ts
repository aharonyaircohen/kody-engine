/**
 * Tiny wrapper around spawn(). Extracted from runPreviewBuild.ts so
 * the side-effecty `runCmd` can be mocked in unit tests without
 * mocking the whole orchestration script.
 *
 * stdio is inherited so docker's progress output streams to the GHA
 * log in real time — without it, a stuck build looks dead until
 * timeout.
 */

import { spawn } from "node:child_process"

export interface RunCmdOpts {
  cwd?: string
  env?: Record<string, string>
  /** Piped to stdin (e.g. `docker login --password-stdin`). */
  input?: string
}

export async function runCmd(cmd: string, args: string[], opts: RunCmdOpts = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: opts.input ? ["pipe", "inherit", "inherit"] : "inherit",
    })
    if (opts.input && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))
    })
  })
}
