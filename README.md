# kody

[![npm](https://img.shields.io/npm/v/@kody-ade/kody-engine.svg)](https://www.npmjs.com/package/@kody-ade/kody-engine)
[![CI](https://github.com/aharonyaircohen/kody-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/aharonyaircohen/kody-engine/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@kody-ade/kody-engine.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@kody-ade/kody-engine.svg)](package.json)

**An autonomous development engine that runs in your GitHub Actions.**

Comment `@kody` on an issue and it implements the change, commits, and opens a
PR — all inside CI, no bot server to host. Comment on a PR with explicit
commands such as `@kody resolve` or `@kody sync` for PR maintenance. It's a
single-session Claude Code agent behind a generic executor and declarative JSON
profiles.

```
You:   open an issue → comment "@kody run"
kody:  reads the issue → writes the code → runs your tests → opens a PR
```

<p align="center">
  <img src="docs/assets/kody-demo.gif" alt="kody demo — issue to tested PR" width="800">
</p>

## Why kody

- **No infrastructure.** Runs on the GitHub Actions you already have. One ~20-line
  workflow file, installed via `npx`. Nothing to deploy or keep online.
- **Whole PR lifecycle, not just authoring.** `run`, `resolve`, `sync`, `merge`,
  `revert`, previews, releases, and scheduled capabilities — one executor, many verbs.
- **Declarative & extensible.** Every command is a folder of `profile.json` +
  `prompt.md` + shell. Add a command by dropping a folder — no engine changes.
- **Bring your own model.** Anthropic native, or any provider via the built-in
  LiteLLM proxy.

## Quickstart

In the repo you want kody to work on:

```bash
npx -y -p @kody-ade/kody-engine@latest kody-engine init
```

Then add **one** repo secret — a model provider key (e.g. `ANTHROPIC_API_KEY`) —
commit the generated `kody.config.json` + `.github/workflows/kody.yml`, and
comment `@kody run` on any issue. That's it. See
[Install in a consumer repo](#install-in-a-consumer-repo) for tokens and
triggers.

## Permissions & safety

kody runs an autonomous agent in your CI with a GitHub token and your model
key. It's built to keep that blast radius small:

- **Least-privilege by default.** Needs `contents` / `pull-requests` / `issues`
  write. A dedicated `KODY_TOKEN` PAT is optional, only for triggering
  downstream CI.
- **Write allowlist.** The agent commits through `commitAndPush`, which blocks
  writes to engine runtime or configuration paths — it can't touch your
  runtime state. See [Delivery boundary](docs/delivery-boundary.md) for what is
  silently discarded, what fails visibly, and how an approved workflow file is
  delivered.
- **Locked-toolbox mode.** A job can declare `tools: [...]` to drop `Bash` and
  shell entirely, running only a fixed set of high-level intents.
- **Review like any contributor.** kody opens PRs; you merge them.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Consumer repo workflow (.github/kody.yml)  │  @kody comments · schedule · manual dispatch
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ kody-engine CLI (@kody-ade/kody-engine)    │
│   bin/kody.ts — entrypoint                  │
│   src/dispatch.ts — capability-driven routing              │
│   src/executor.ts — runs capability implementations         │
│   backend capability definition                                │
│     profile.json · capability.md · optional skills/scripts  │
│   src/scripts/*.ts — cross-cutting catalog  │
└─────────────────────────────────────────────┘
```

Every top-level command is an auto-discovered capability action. The router has
**zero implementation names hardcoded** - comment dispatch resolves the first token
after `@kody` through `config.aliases`, then falls back to
`config.defaultImplementation` / `config.defaultPrImplementation` as default
capability actions. Drop a new `backend capability definition` directory with
`profile.json` + `capability.md`.

Capability implementation profiles are private implementation units and contain
**only** three kinds of files: `profile.json` (declaration), `prompt.md` (agent
instructions), and `.sh` scripts (mechanical side-effect work). Cross-cutting
TypeScript lives in [src/scripts/](src/scripts/); it can't import from
`src/implementations/` and can't branch on `profile.name`.

## Install in a consumer repo

```bash
npx -y -p @kody-ade/kody-engine@latest kody-engine init
```

`kody-engine init` scaffolds [kody.config.json](kody.config.schema.json) and the
single generic `.github/workflows/kody.yml` launcher. The Engine discovers and
fans out scheduled capabilities at runtime, so capability schedules never
generate additional GitHub workflow files. Idempotent — pass `--force` to
overwrite.

Store model provider keys (for example `MINIMAX_API_KEY`) in the connected
repository's Kody vault. GitHub Actions uses OIDC to request only the selected
model key at runtime; user secrets are not copied into Actions. `KODY_TOKEN`
remains an optional GitHub authentication fallback when Kody must trigger
downstream workflows or modify `.github/workflows/*`.

The consumer workflow listens on `issue_comment` for `@kody ...` dispatch and `workflow_dispatch` for manual runs and chat mode. Convex owns scheduled Loop wakeups.

Live chat transcripts remain in Kody's canonical backend. In GitHub Actions,
the Engine uses the workflow's short-lived OIDC identity to call Dashboard's
repository-scoped backend endpoint; consumer repositories must not receive
`CONVEX_URL` or `KODY_SERVICE_KEY`. Local and server runtimes may connect
directly with those two variables when no GitHub Actions identity exists.

## Commands

```
# The published bin is `kody-engine` (renamed from `kody` in v0.4.77 to avoid
# shadowing a consumer repo's own `kody` bin). Install globally or via `npx`.

# issue authoring
kody-engine run               --issue <N>                     # implement an issue end-to-end

# PR operations
kody-engine resolve           --pr <N> [--prefer ours|theirs] # merge default branch, resolve conflicts
kody-engine sync              --pr <N>                         # merge default into a PR branch
kody-engine merge             --pr <N>                         # merge a green PR
kody-engine revert            --pr <N> --shas <sha...>         # mechanically revert PR commits
kody-engine preview-build     --pr <N>                         # build and publish a PR preview

# release operations
kody-engine release           --issue <N> [--bump patch|minor|major] [--dry-run]
kody-engine release-prepare   --issue <N> [--bump patch|minor|major] [--dry-run]
kody-engine release-publish   --issue <N> [--dry-run]
kody-engine release-deploy    --issue <N> [--dry-run]
kody-engine npm-publish       [--tag latest] [--access public] [--dry-run]

# scheduled capabilities and goals
kody-engine capability-scheduler                                    # fan out due backend capability definition folders plus legacy fallbacks
kody-engine capability-tick          --capability <slug> [--force]        # one agent tick for one capability
kody-engine capability-tick-scripted --capability <slug> [--force]        # one deterministic tickScript capability tick
kody-engine goal-scheduler                                    # fan out active goal instances in configured backend
kody-engine goal-manager      --goal <id>                     # advance one managed goal instance

# setup, servers, and utilities
kody-engine init              [--force]                       # scaffold consumer repo
kody-engine ci                                                # auto-dispatch from the GitHub Actions event
kody-engine chat              [--session <id>]                # dashboard-driven chat session
kody-engine serve                                             # LiteLLM/editor helper
kody-engine brain-serve                                       # Brain SSE server
kody-engine pool-serve                                        # warm-pool owner
kody-engine runner-serve                                      # warm-pool one-shot runner
kody-engine agent-ask        --agent <slug> --message "..." # ad-hoc agent run
kody-engine stats                                             # inspect run/event history
```

### Capabilities

A **capability** is a folder at `backend capability definition` with
`profile.json` metadata (`action`, `capabilityKind`, `agent`, `every`, and
related fields) plus human-owned prose in `capability.md`. The scheduler wakes
on cron, finds due capabilities, and dispatches either
`capability-tick` for an agent tick or
`capability-tick-scripted` for a deterministic `tickScript`
capability. The CLI names are still legacy during migration.

Locked-toolbox capabilities can declare `"tools": [...]` in `profile.json` to
run with only the named high-level MCP intents plus `submit_state`; capabilities
without `tools` keep the legacy Bash/gh toolbox.

### `release`

`release` is a single deterministic flow: bump version files, update `CHANGELOG.md`, open or reuse a release PR, wait for CI, merge, publish, deploy, and notify. `release-prepare`, `release-publish`, and `release-deploy` remain available as explicit stage commands.

## Profiles

A profile is declarative JSON plus an adjacent markdown body. New public work
should live under `backend capability definition` with `capability.md`; legacy
implementations under [src/implementations/](src/implementations/) still show the
older split profile + prompt shape. Adding a new capability should not require
executor, entry, or dispatch changes.

See [AGENTS.md](AGENTS.md) for the full architectural contract.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev
loop and the invariants to respect, and [AGENTS.md](AGENTS.md) for the deep
architecture. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Aharon Yair Cohen
