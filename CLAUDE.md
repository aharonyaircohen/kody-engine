# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package

`@kody-ade/kody-engine` — an autonomous development engine that runs Claude Code in CI against GitHub issues/PRs. ESM, Node ≥22, published to npm as a CLI (`kody` binary). Only runtime dep is `@anthropic-ai/claude-agent-sdk`. Read [AGENTS.md](AGENTS.md) for full project context, invariants, and release history — it is the source of truth.

## Commands

```bash
pnpm kody <mode> ...    # dev runner (tsx bin/kody.ts)
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
- **Executable profile** — each `src/executables/<name>/profile.json` is pure JSON declaring CLI inputs, Claude Agent SDK config (tools, model, hooks, skills), `cliTools` the scripts expect, and the ordered preflight/postflight script list. The agent prompt lives alongside as `prompt.md`. Executable-local TypeScript/shell scripts (`flow.ts`, `apply-prefer.sh`, etc.) are **encouraged** and colocated in the same directory.
- **Scripts** ([src/scripts/](src/scripts/)) — deterministic functions registered in [src/scripts/index.ts](src/scripts/index.ts). **Only genuinely cross-cutting utilities live here** (`commitAndPush`, `composePrompt`, `verify`, `ensurePr`, `postIssueComment`). Per-executable logic lives with its executable, not here. The agent never commits — `commitAndPush` does.
- **Agent invocation** ([src/agent.ts](src/agent.ts)) — calls `@anthropic-ai/claude-agent-sdk` with profile-declared tools/hooks/skills. [src/litellm.ts](src/litellm.ts) manages a proxy when a non-Anthropic model is configured.

### Invariants (do not break — see AGENTS.md)

1. Executor stays role-agnostic. No `run`/`fix`/`review` strings or branching in [src/executor.ts](src/executor.ts).
2. **Profiles** (`profile.json`) are pure JSON. **Executable-local scripts** (`.ts`, `.sh`) are encouraged inside `src/executables/<name>/` — anything specific to one executable belongs with it. `src/scripts/` is for cross-cutting utilities used by multiple executables. Prefer a small shell script colocated with the executable over adding a TS function to `src/scripts/`.
3. Scripts compose via `runWhen` — it is the only conditional primitive available to profiles.
4. Wrapper/verification/git logic belongs in scripts (postflight), not inline in executor or profile.
5. Consumer workflow YAML ([templates/kody.yml](templates/kody.yml)) stays thin; capabilities ship via npm.

Adding a new command = new `src/executables/<name>/` + `profile.json` + `prompt.md` + register scripts. Issue-triggered commands need no dispatch edits — the PR switch in [src/dispatch.ts](src/dispatch.ts) does (no generic fallthrough there), and names overlapping via `\b…\b` word boundaries (e.g. `ui-review` vs `review`) must be ordered by specificity.

## Exit codes

0 success · 1 agent FAILED · 2 verify failed · 3 no commits · 4 PR creation failed · 5 uncommitted changes · 64 invalid args · 99 crash.

## Release

Version lives in `package.json` only ([src/entry.ts](src/entry.ts) reads it from there at runtime). Bump, tag `vX.Y.Z`, and push with `--follow-tags`. Publish is manual (`pnpm publish --access public`, which runs `prepublishOnly → build`). Default to patch bumps unless the user requests otherwise.

## Live testing

End-to-end behavior is exercised against `aharonyaircohen/Kody-Engine-Tester` (Next.js + Payload CMS). That repo triggers `@kody` comments on issues/PRs.
