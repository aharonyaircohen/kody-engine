# kody-engine — project context for agents

## What this is

`@kody-ade/kody-engine` (npm) is **kody2**, an autonomous development engine. One `@kody2` comment on a GitHub issue (or PR) runs Claude Code in CI, implements the change, commits, and opens or updates a PR.

Under the hood it is one **generic executor** running **one declarative executable profile** (`build`). No multi-stage pipeline, no orchestration logic baked into the engine.

## Architecture (two layers, nothing else)

```
┌─────────────────────────────────────────────────────────────┐
│ Consumer repo .github/workflows/kody2.yml                   │
│   (≈20 lines of YAML — minimal, stays dumb)                 │
│   trigger: @kody2 comment or workflow_dispatch              │
│   runs: npx @kody-ade/kody-engine@latest kody2 ci           │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 1. Generic executor (src/executor.ts)                       │
│    - loads profile.json                                     │
│    - validates CLI args                                     │
│    - verifies CLI tool contracts                            │
│    - runs preflight scripts → agent → postflight scripts    │
│    - knows nothing about build/run/fix — it just executes   │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. Executable profile (src/executables/<name>/profile.json) │
│    declarative JSON: inputs, allowed SDK tools, Claude Code │
│    features (hooks/skills/commands/subagents/plugins/MCP),  │
│    cliTools with install/verify/usage contracts, preflight  │
│    and postflight script lists with optional runWhen rules. │
│    Adjacent prompt files under prompts/<mode>.md.           │
│    Today there is exactly one executable: `build`.          │
└─────────────────────────────────────────────────────────────┘
                              ↓
        Fixed script catalog (src/scripts/*.ts)
        runFlow / fixFlow / fixCiFlow / resolveFlow
        loadConventions / loadCoverageRules / composePrompt
        parseAgentResult / verify / checkCoverageWithRetry
        commitAndPush / ensurePr / postIssueComment
```

## Modes of the `build` executable

Selected by the `--mode` input, resolved from the GHA event by `src/dispatch.ts`:

| Mode      | Input    | Triggered by                                   |
|-----------|----------|------------------------------------------------|
| `run`     | `--issue`| `@kody2` on an issue, or `workflow_dispatch`   |
| `fix`     | `--pr`   | `@kody2` (or `@kody2 fix …`) on a PR comment   |
| `fix-ci`  | `--pr`   | `@kody2 fix-ci` on a PR                        |
| `resolve` | `--pr`   | `@kody2 resolve` on a PR                       |

CLI users can also invoke `kody2 run/fix/fix-ci/resolve` directly.

## Repo layout

```
src/
  executor.ts            — the single atomic runner
  profile.ts             — profile loader + validator
  tools.ts               — cliTools contract verifier
  dispatch.ts            — auto-detects mode from GHA event
  agent.ts               — Claude Code SDK invocation
  litellm.ts             — proxy lifecycle (for non-Anthropic providers)
  kody2-cli.ts           — `kody2 ci` preflight (install, secrets, git identity)
  entry.ts               — CLI dispatcher (run/fix/fix-ci/resolve/ci/help)
  gha.ts                 — GHA helpers (run URL, 👀 reaction on trigger)
  {branch,commit,pr,verify,issue,coverage,prompt,format,config}.ts
  executables/
    types.ts
    build/
      profile.json
      prompts/{run,fix,fix-ci,resolve}.md
  scripts/
    {runFlow,fixFlow,fixCiFlow,resolveFlow}.ts
    {loadConventions,loadCoverageRules,composePrompt}.ts
    {parseAgentResult,verify,checkCoverageWithRetry}.ts
    {commitAndPush,ensurePr,postIssueComment}.ts
    index.ts             — registry that maps name → function
bin/kody2.ts             — thin shebang wrapper
templates/kody2.yml      — workflow to drop in consumer repos
tests/
  unit/                  — 169 unit tests
  int/                   — integration tests
  e2e/                   — 7 CLI smoke tests
```

## Key invariants (do not break)

1. **The executor never references role-specific concepts.** No `build` / `run` / `fix` / `issue` / `pr` inside `executor.ts`. Only: profile, scripts, context, SDK call.
2. **Profiles are data, not code.** A profile is pure JSON + markdown prompts. Adding a new executable = new `src/executables/<name>/` dir + register any new scripts.
3. **Scripts compose freely, one does one thing.** Each script is a small deterministic function. `runWhen` (dotted-path equality against context) is the only conditional primitive.
4. **Wrapper logic belongs in scripts, not inline.** No "wrapper layer" between executor and agent. `verify`/`commitAndPush`/`ensurePr`/`postIssueComment` etc. are all postflight scripts.
5. **The workflow YAML stays minimal.** Any new capability ships via npm, not via consumer YAML edits.

## Version history / split context

- Legacy engine lives at **`aharonyaircohen/Kody-Engine-Lite`** under the package name `@kody-ade/engine`, frozen at v0.7.14. Do not add features there.
- This repo (`aharonyaircohen/kody-engine`, package `@kody-ade/kody-engine`) is a clean split — only the executor + Build executable + scripts survived the move. No `src-v2/`, no `kody-lean`, no 7-stage pipeline history.
- Current version: see `package.json` (started at `0.2.0` because `0.1.x` was taken on npm by a deprecated predecessor). **Patches only** — do not bump minor/major without explicit ask.

## Tester / live-test repo

**`aharonyaircohen/Kody-Engine-Tester`** is the live-test bed. It is a Next.js + Payload CMS LMS with intentional pre-existing quality-gate failures (TypeScript errors, time-sensitive tests, missing Postgres) so verify drafts are informative, not scary.

- Its `.github/workflows/kody2.yml` pulls `@kody-ade/kody-engine@latest` via `npx`. Version bumps propagate automatically on next run.
- Its `kody.config.json` declares `agent.model`, quality commands, and `testRequirements` (route.ts files require a sibling `route.test.ts`).
- To live-test a change: publish the new kody2 version, comment `@kody2` on a fresh issue there (or PR comment for fix/fix-ci/resolve).

## How to proceed on a new session

1. Read the relevant code in `src/` — start with `executor.ts` and the profile it loads at `src/executables/build/profile.json`.
2. For feature requests: is it an **executable profile** change (new mode or new role) or a **script** change (new hook) or an **executor** change (new conditional primitive / new SDK surface)? 90% of the time it's scripts or profile.
3. `pnpm typecheck && pnpm test && pnpm test:e2e` before any commit.
4. Release flow: bump patch in `package.json`, update version string in `src/entry.ts`, commit, tag `vX.Y.Z`, `git push --follow-tags`, `npm publish --access public`.
5. Live-test on the tester before declaring success.

## External dependencies worth knowing

- **`@anthropic-ai/claude-agent-sdk`** — the Claude Code SDK the executor calls via `runAgent`.
- **LiteLLM** — started by `src/litellm.ts` when the configured model isn't Anthropic-native.
- **`gh` CLI** — the only way kody2 talks to GitHub. Never use the raw API directly in new scripts.
