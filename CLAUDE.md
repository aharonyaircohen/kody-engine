# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package

`@kody-ade/kody-engine` — an autonomous development engine that runs Claude Code in CI against GitHub issues/PRs. ESM, Node ≥22, published to npm as a CLI (`kody-engine` binary). Only runtime dep is `@anthropic-ai/claude-agent-sdk`. Read [AGENTS.md](AGENTS.md) for full project context, invariants, and release history — it is the source of truth.

## Commands

```bash
pnpm kody:run <mode> ...    # dev runner (tsx bin/kody.ts)
pnpm build               # tsup bundle + copy src/executables → dist/executables
pnpm typecheck           # tsc --noEmit
pnpm test                # vitest run tests/unit + tests/int
pnpm test:e2e            # vitest run tests/e2e
pnpm test:all            # all of tests/

# Single test file / test name
pnpm vitest run tests/unit/executor.test.ts
pnpm vitest run -t "runs preflight scripts in order"
```

CI runs `typecheck` + `test` + `test:e2e` on PR/push to main ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Architecture

Two-layer design: **generic executor** + **declarative executable profile** + **script catalog**.

- **Executor** ([src/executor.ts](src/executor.ts)) — loads a profile, validates CLI inputs/cliTools, runs preflight scripts → agent → postflight scripts. Knows nothing about `run`/`fix`/`review` — those concepts live only in profiles and scripts.
- **Entry & dispatch** — [bin/kody.ts](bin/kody.ts) → [src/entry.ts](src/entry.ts). The only hardcoded verbs are `ci`, `help`, `version`. Everything else (`run`, `fix`, `fix-ci`, `resolve`, `review`, `ui-review`, `plan`, `orchestrator`, `release`, `watch-*`, `init`) is an auto-discovered executable under [src/executables/](src/executables/). [src/dispatch.ts](src/dispatch.ts) picks an executable from the GHA event when invoked as `kody ci`.
- **Executable** — each `src/executables/<name>/` contains `profile.json` (declaration), `prompt.md` (agent instructions), and `.sh` scripts (mechanical side-effect work). It MAY also contain `skills/<name>/`, `commands/<name>.md`, `agents/<name>.md`, or `hooks/<name>.json` — Claude Agent SDK plugin parts that are specific to this one executable. No TypeScript inside executable directories. The profile declares CLI inputs, Claude Agent SDK config (tools, model, hooks, skills), `cliTools`, and the ordered preflight/postflight script list. Each entry in the script list is either a registered TS function from `src/scripts/` or a shell script colocated with the executable.
- **Scripts** ([src/scripts/](src/scripts/)) — TypeScript, registered in [src/scripts/index.ts](src/scripts/index.ts). **Only cross-cutting utilities used by multiple executables** (`commitAndPush`, `composePrompt`, `verify`, `ensurePr`, `postIssueComment`). The agent never commits — `commitAndPush` does.
- **Agent invocation** ([src/agent.ts](src/agent.ts)) — calls `@anthropic-ai/claude-agent-sdk` with profile-declared tools/hooks/skills. [src/litellm.ts](src/litellm.ts) manages a proxy when a non-Anthropic model is configured.

### Invariants (do not break — see AGENTS.md)

1. Executor stays role-agnostic. No `run`/`fix`/`review` strings or branching in [src/executor.ts](src/executor.ts).
2. **Executable directories contain only `profile.json`, `prompt.md`, `.sh` scripts, and optional plugin-part subdirs (`skills/`, `commands/`, `agents/`, `hooks/`).** TypeScript lives exclusively in `src/scripts/`, and only for logic shared across multiple executables. Plugin-part subdirs ship Claude Agent SDK assets (markdown / JSON, no TS) that are specific to this one executable; `buildSyntheticPlugin` resolves them from the executable dir first, then falls back to the central catalog under `src/plugins/`. **Design smell**: if a piece of logic is too complex for shell AND specific to one executable, that's a warning sign — either simplify the logic so shell can express it, or promote the piece into a cross-cutting utility in `src/scripts/`. Never the middle ground ("just this once I'll put executable-specific TS somewhere").
3. Scripts compose via `runWhen` — it is the only conditional primitive available to profiles.
4. Wrapper/verification/git logic belongs in scripts (postflight), not inline in executor or profile.
5. **The consumer workflow stays minimal — capability ships via `npm`, not YAML.** `kody-engine init` generates `.github/workflows/kody.yml` from the `WORKFLOW_TEMPLATE` string in [src/scripts/initFlow.ts](src/scripts/initFlow.ts), pinned to `@latest` — so a republish reaches every consumer (there is no per-consumer version pin to sync). Don't casually edit `WORKFLOW_TEMPLATE` / `renderScheduledWorkflow`, don't add new `.github/workflows/*.yml` files (no `kody-<feature>.yml`), and no multi-job `needs:` / matrix / `if:` flow logic in any workflow. All capability ships via `npm publish`.
6. **"Kody Duty" means `.kody/duties/<slug>.md`** — a markdown file in the consumer repo describing the duty's intent. Ticked by the existing `duty-scheduler` watch on every `kody.yml` wake. Contract: [src/executables/duty-tick/prompt.md](src/executables/duty-tick/prompt.md). When the user asks for "a duty" (the new domain noun for what was historically a "job"), this is the default shape — no YAML, no engine code, no publish. The legacy `job-*` executable family was renamed to `duty-*` in Phase 1 of the rename (issue #38); the `Job` runtime envelope in `src/job.ts` and the `kody-job-next-state` fence label are separate concerns and stay.
7. **Watch executables are a separate shape** — engine-shipped at `src/executables/<name>/profile.json` with `role: "watch"`, `kind: "scheduled"`, and a `schedule` cron. Fanned out by [`dispatchScheduledWatches`](src/dispatch.ts) on each wake. Output via `postIssueComment`, never `commitAndPush`. Use only for cross-consumer features that must ship in the npm package. Canonical: [src/executables/watch-stale-prs/](src/executables/watch-stale-prs/). Don't call these "jobs".

Adding a new command = new `src/executables/<name>/` + `profile.json` + `prompt.md` + register scripts. Issue-triggered commands need no dispatch edits — the PR switch in [src/dispatch.ts](src/dispatch.ts) does (no generic fallthrough there), and names overlapping via `\b…\b` word boundaries (e.g. `ui-review` vs `review`) must be ordered by specificity.

## Exit codes

0 success · 1 agent FAILED · 2 verify failed · 3 no commits · 4 PR creation failed · 64 invalid args · 99 crash · 124 shell timed out.

## Release

Version lives in `package.json` only ([src/entry.ts](src/entry.ts) reads it from there at runtime). Every release:

1. Bump `package.json` version.
2. Tag `vX.Y.Z`, push with `--follow-tags`. Publish is manual (`pnpm publish --access public`, which runs `prepublishOnly → typecheck + test + build`).

Default to patch bumps unless the user requests otherwise. Consumers run `@latest` (the workflow `kody-engine init` writes), so a republish reaches everyone — there is no per-consumer pin to resync.

**Rollback.** Because consumers track `@latest`, a bad publish hits everyone at once with no pin to fall back to. To revert instantly, re-point `latest` at the last good version (no republish needed):

```bash
npm dist-tag add @kody-ade/kody-engine@<last-good-version> latest
```

Then fix forward and publish a new patch. `prepublishOnly` runs `typecheck + test + build`, so a red build can't publish in the first place.

## Live testing

End-to-end behavior is exercised against `aharonyaircohen/Kody-Engine-Tester` (Next.js + Payload CMS). That repo triggers `@kody` comments on issues/PRs.
