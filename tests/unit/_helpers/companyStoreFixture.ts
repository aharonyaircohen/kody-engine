/**
 * Test fixture: a temp directory that looks enough like the kody-company-store
 * for `getCompanyStoreRoot()` to recognise it and for `resolveExecutable()` /
 * `listCapabilityActions()` to discover its `.kody/capabilities/<slug>/profile.json`
 * folders as both public capabilities and implementation profiles.
 *
 * `localStoreRoot()` accepts any absolute path with a `.kody` subfolder, so we
 * don't need a real git repo — tests that need a writable store can call this
 * and point `KODY_COMPANY_STORE` at the result. Consumers must save/restore the
 * previous env values and call `resetCompanyStoreCacheForTests()` so the
 * memoized store root is rebuilt.
 *
 * Use the `merge` and `resolve` profiles only when the test actually exercises
 * their shape — they intentionally mirror the company-store originals so unit
 * tests catch drift early.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface CompanyStoreFixture {
  /** Absolute path to the temp store root. Has a `.kody/capabilities/...` tree inside. */
  root: string
  /** Tear down: restore prior env, clear memoized store cache, remove temp dir. */
  cleanup: () => void
}

const MINIMAL_EXEC = {
  name: "noop",
  role: "primitive",
  kind: "oneshot",
  describe: "No-op implementation profile used as a placeholder executable.",
  inputs: [],
  claudeCode: {
    model: "inherit",
    permissionMode: "acceptEdits",
    maxTurns: null,
    systemPromptAppend: null,
    tools: [],
    hooks: [],
    skills: [],
    commands: [],
    subagents: [],
    plugins: [],
    mcpServers: [],
  },
  cliTools: [],
  scripts: { preflight: [], postflight: [] },
}

export interface CompanyStoreFixtureOptions {
  /** Slugs to materialize as capability folders; defaults to the four the
   * engine test-suite exercises: `fix`, `fix-ci`, `resolve`, `merge`. */
  capabilities?: string[]
}

/**
 * Build a temp company-store fixture and point `KODY_COMPANY_STORE` at it.
 * Always call `cleanup()` in `afterEach` (or in `finally`) — the function
 * does NOT install a global hook, so leaks are the caller's fault.
 */
export function setupCompanyStoreFixture(opts: CompanyStoreFixtureOptions = {}): CompanyStoreFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kody-store-fixture-"))
  const slugs = opts.capabilities ?? ["fix", "fix-ci", "resolve", "merge"]
  for (const slug of slugs) {
    writeCapabilityFolder(root, slug, profileFor(slug))
  }

  const previousStore = process.env.KODY_COMPANY_STORE
  const previousRef = process.env.KODY_COMPANY_STORE_REF
  process.env.KODY_COMPANY_STORE = root
  process.env.KODY_COMPANY_STORE_REF = "stable"

  return {
    root,
    cleanup: () => {
      if (previousStore === undefined) delete process.env.KODY_COMPANY_STORE
      else process.env.KODY_COMPANY_STORE = previousStore
      if (previousRef === undefined) delete process.env.KODY_COMPANY_STORE_REF
      else process.env.KODY_COMPANY_STORE_REF = previousRef
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

function writeCapabilityFolder(storeRoot: string, slug: string, profile: Record<string, unknown>): void {
  const dir = path.join(storeRoot, ".kody", "capabilities", slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "profile.json"), `${JSON.stringify(profile, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, "capability.md"), `# ${slug}\n\nTest fixture capability.\n`)
}

function profileFor(slug: string): Record<string, unknown> {
  switch (slug) {
    case "fix":
      return {
        name: "fix",
        action: "fix",
        agent: "kody",
        role: "primitive",
        kind: "oneshot",
        describe: "Apply review feedback to an existing PR branch.",
        inputs: [
          { name: "pr", flag: "--pr", type: "int", required: true, describe: "PR number." },
          { name: "feedback", flag: "--feedback", type: "string", describe: "Inline feedback override." },
        ],
        claudeCode: {
          model: "inherit",
          permissionMode: "acceptEdits",
          maxTurns: null,
          systemPromptAppend: null,
          tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
          hooks: ["block-git"],
          skills: [],
          commands: [],
          subagents: [],
          plugins: [],
          mcpServers: [],
        },
        cliTools: [],
        scripts: {
          preflight: [{ script: "fixFlow" }],
          postflight: [{ script: "requireFeedbackActions" }],
        },
      }
    case "fix-ci":
      return {
        name: "fix-ci",
        action: "fix-ci",
        agent: "kody",
        role: "primitive",
        kind: "oneshot",
        describe: "Fix a failing CI workflow on an existing PR.",
        inputs: [
          { name: "pr", flag: "--pr", type: "int", required: true, describe: "PR number." },
          { name: "runId", flag: "--run-id", type: "string", describe: "Workflow run ID." },
        ],
        claudeCode: {
          model: "inherit",
          permissionMode: "acceptEdits",
          maxTurns: null,
          systemPromptAppend: null,
          tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
          hooks: ["block-git"],
          skills: [],
          commands: [],
          subagents: [],
          plugins: [],
          mcpServers: [],
        },
        cliTools: [],
        scripts: {
          preflight: [{ script: "fixCiFlow" }],
          postflight: [],
        },
      }
    case "resolve":
      // Mirrors the company-store `resolve` shape so executor.test.ts can lock
      // in the preflight chain (`setLifecycleLabel` → `resolveFlow`) and the
      // absence of verify / coverage-ratchet postflights (resolve is a merge op).
      return {
        name: "resolve",
        action: "resolve",
        agent: "kody",
        role: "primitive",
        kind: "oneshot",
        describe: "Resolve merge conflicts between a PR branch and the default branch.",
        inputs: [
          { name: "pr", flag: "--pr", type: "int", required: true, describe: "PR number." },
          {
            name: "prefer",
            flag: "--prefer",
            type: "enum",
            values: ["ours", "theirs"],
            describe: "Force one side for every conflict.",
          },
        ],
        claudeCode: {
          model: "inherit",
          permissionMode: "acceptEdits",
          maxTurns: null,
          systemPromptAppend: null,
          tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
          hooks: ["block-git"],
          skills: [],
          commands: [],
          subagents: [],
          plugins: [],
          mcpServers: [],
        },
        cliTools: [],
        scripts: {
          preflight: [{ script: "setLifecycleLabel" }, { script: "resolveFlow" }, { script: "composePrompt" }],
          postflight: [{ script: "commitAndPush" }],
        },
      }
    case "merge":
      // Standalone executable profile used as the "how" referenced by thin
      // capability contracts (see profile.test.ts "resolves a capability that
      // references an executable"). The shape just needs role+kind+inputs+
      // claudeCode — the test only asserts the overlay succeeded.
      return {
        ...MINIMAL_EXEC,
        name: "merge",
        action: "merge",
        describe: "Self-gating squash-merge of an open PR into its base.",
        inputs: [{ name: "pr", flag: "--pr", type: "int", required: true, describe: "PR number." }],
      }
    default:
      return {
        ...MINIMAL_EXEC,
        name: slug,
        action: slug,
      }
  }
}
