# Contributing to kody-engine

Thanks for your interest. This guide gets you from a fresh clone to a merged PR.
For the deep design rationale, release history, and invariants behind every
decision, [AGENTS.md](AGENTS.md) is the source of truth — read it before any
non-trivial change.

## What kody is

`@kody-ade/kody-engine` is an autonomous development engine: a single-session
Claude Code agent behind a **generic executor** + **declarative agentAction
profiles** + a **shared script catalog**. The executor knows nothing about
`run`/`fix`/`review`; those concepts live entirely in profiles and scripts.
See the architecture diagram in [README.md](README.md) and the deeper write-up
in [CLAUDE.md](CLAUDE.md).

## Prerequisites

- **Node ≥ 22**
- **pnpm** (`corepack enable` if you don't have it)

## Quick start

```bash
git clone https://github.com/aharonyaircohen/kody-engine.git
cd kody-engine
pnpm install

pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run tests/unit + tests/int, with coverage
pnpm lint           # biome check
pnpm build          # tsup bundle + copy src/agent-actions → dist
```

Run the CLI locally without building:

```bash
pnpm kody:run <mode> ...        # e.g. pnpm kody:run review --pr 1
```

Run a single test file or by name:

```bash
pnpm vitest run tests/unit/initFlow.test.ts
pnpm vitest run -t "runs preflight scripts in order"
```

## Project layout

```
bin/kody.ts                entrypoint → src/entry.ts
src/executor.ts            runs one profile (role-agnostic — no command names)
src/dispatch.ts            picks an agentAction from a GitHub event
src/agent-actions/<name>/    profile.json · prompt.md · *.sh  (+ optional plugin parts)
src/scripts/*.ts           cross-cutting TypeScript, registered in src/scripts/index.ts
templates/kody.yml         consumer workflow template (release-only — see invariant 5)
tests/{unit,int,e2e}/      vitest suites
```

## The invariants (read before editing)

These are load-bearing. A PR that breaks one will be asked to change. Full
reasoning lives in [CLAUDE.md](CLAUDE.md) and [AGENTS.md](AGENTS.md).

1. **The executor stays role-agnostic.** No `run`/`fix`/`review` strings or
   branching in [src/executor.ts](src/executor.ts).
2. **AgentAction directories hold only** `profile.json`, `prompt.md`, `.sh`
   scripts, and optional plugin-part subdirs (`skills/`, `commands/`,
   `agents/`, `hooks/`). **No TypeScript inside an agentAction directory.** TS
   lives only in `src/scripts/`, and only for logic shared by multiple
   agentActions. If logic is too complex for shell *and* specific to one
   agentAction, simplify it or promote it to a cross-cutting script — never the
   middle ground.
3. **`runWhen` is the only conditional primitive** available to profiles.
4. **Wrapper / verification / git logic belongs in postflight scripts**, never
   inline in the executor or a profile. The agent never commits — `commitAndPush`
   does.
5. **Never touch YAML except as part of a release.** [templates/kody.yml](templates/kody.yml),
   `initFlow.ts`'s `WORKFLOW_TEMPLATE` / `renderScheduledWorkflow`, and any
   `.github/workflows/*.yml` are otherwise read-only. No new workflow files; all
   capability ships via `npm publish`.

## Adding a new command (agentAction)

The most common contribution. An issue-triggered command needs **no** dispatch
edits.

1. Create `src/agent-actions/<name>/` with:
   - **`profile.json`** — declares CLI inputs, Claude Code config (tools, model,
     hooks, skills), `cliTools`, lifecycle, and the ordered preflight/postflight
     script list. Copy [src/agent-actions/fix/profile.json](src/agent-actions/fix/profile.json)
     as a starting shape.
   - **`prompt.md`** — the agent instructions.
   - Any `.sh` scripts for mechanical side-effect work, colocated here.
2. If you need shared logic, add `src/scripts/<name>.ts` and **register it** in
   [src/scripts/index.ts](src/scripts/index.ts) — a profile referencing an
   unregistered script name fails at load.
3. `pnpm kody:run <name> ...` to try it. Add tests under `tests/unit/`.

PR-triggered commands need a case in the dispatch switch in
[src/dispatch.ts](src/dispatch.ts) (there is no generic fallthrough). Names that
overlap via `\b…\b` word boundaries (e.g. `ui-review` vs `review`) must be
ordered most-specific-first.

## Testing

- Cover new logic with `tests/unit/`; integration behavior in `tests/int/`.
- The full PR gate is `pnpm typecheck && pnpm test && pnpm test:e2e`, mirroring
  [.github/workflows/ci.yml](.github/workflows/ci.yml).
- `pretest` runs `check:modularity` — it fails if agentAction dirs gain
  disallowed file types (invariant 2). Keep it green.

## Commits & PRs

- Conventional commit prefixes: `feat`, `fix`, `refactor`, `docs`, `test`,
  `chore`, `perf`, `ci`.
- Keep PRs focused; describe *why*, not just *what*. Reference the issue.
- Make sure typecheck, tests, and lint pass before requesting review.

## Releasing (maintainers only)

Versioning is patch-by-default and tightly coupled to the template pin — see the
**Release** section of [CLAUDE.md](CLAUDE.md). Contributors don't bump versions
in a PR; maintainers cut releases.

## Security

This engine runs AI-generated code in CI with repository write tokens. If you
find a vulnerability, **don't open a public issue** — report it privately to the
maintainers via [GitHub Security Advisories](https://github.com/aharonyaircohen/kody-engine/security/advisories/new).
