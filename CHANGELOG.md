# Changelog

All notable changes to `@kody-ade/kody-engine` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
— in practice, releases are **patch-by-default** (see the Release section of
[CLAUDE.md](CLAUDE.md)).

> This file summarizes notable, user-facing changes. The `0.4.x` line has 200+
> patch releases; the full per-commit history lives in `git log` and the release
> narrative in [AGENTS.md](AGENTS.md). Each git tag `vX.Y.Z` corresponds to a
> published npm version.

## [Unreleased]

### Added

- Agent loops can now dispatch a target goal after their preferred local runtime, once per local day.

### Fixed

- Managed goals retry still-missing pending evidence instead of waiting forever after the first dispatch.
- Workflow dispatch no longer forwards issue or base arguments to capabilities
  that do not declare those inputs.

## [0.4.211] — restore fix-ci command

### Fixed
- Restored the shipped `fix-ci` executable so `kody-engine fix-ci --pr <N>`
  and `@kody fix-ci` on PR comments resolve again.

## [0.4.210] — restore fix command

### Fixed
- Restored the shipped `fix` executable so `kody-engine fix --pr <N>` and
  `@kody fix` on PR comments resolve again.
- **Hollow "success" detection via a backend health probe.** When the LiteLLM
  proxy crashes mid-request, the Claude Agent SDK can still emit a `success`
  result (1 turn, $0) — sometimes carrying its own error string as the result
  text, which slipped past the zero-output heuristic (A-Guy #2211). After any
  non-mutating "success" the engine now probes the proxy directly; a dead proxy
  proves the success is hollow, so the run is demoted and routed through the
  restart-and-retry path — which **dumps the proxy log tail** (the only place
  the crash reason surfaces) and gives the task a real second attempt instead
  of failing silently. New `isBackendHealthy` hook on the agent; pure probe
  (`isHealthy`) added to the LiteLLM handle.
- **LiteLLM proxy startup timeout raised 60s → 150s.** On a cold CI runner the
  proxy needs ~60-65s before `/health` first answers (heavy `import litellm`).
  The old 60s deadline lost that race by a few seconds and threw "failed to
  start" even though the proxy came up moments later — the actual root cause
  behind the "unreachable proxy" empty-PR runs. Overridable via
  `KODY_LITELLM_TIMEOUT_SEC`.
- **No-work runs no longer ship an empty PR.** When the Claude Agent SDK
  returns a `success` result that never reached the model — the dead-proxy
  signature: subtype `success`, 1 turn, `$0`, no result text, `ConnectionRefused`
  on stderr — the agent now demotes it to a *failed* run instead of trusting it.
  This routes the run through the existing connection-retry path, which calls
  `ensureBackend()` to **restart a crashed LiteLLM proxy and dump its log tail**,
  and on exhaustion ends `failed` so commit + `ensurePr` skip it. Previously such
  a run committed whatever litter was in the working tree and opened a hollow PR.
- **Never commit `.codegraph/` runtime scratch.** The codegraph repo-map tool's
  `daemon.pid`, socket, db, and its own `.gitignore` are machine-local and are
  now in the commit blocklist, so they can't be swept into a commit.

### Changed
- `kody init` now derives the generated config's `$schema` URL from this
  package's `repository.url` instead of a hardcoded path, so a fork republished
  under its own scope points consumers at its own schema.

### Added
- `CONTRIBUTING.md` — contributor onboarding, invariants, and a "add an
  executable" walkthrough.
- `CHANGELOG.md` — this file.

## [0.4.110] — warm-pool runner

### Added
- Warm-pool `runner-serve` + `pool-serve`: per-repo runner pools sourced from
  each repo's vault, with self-healing claim retries and periodic resync.
- Interactive job mode that pre-warms the Vibe chat runner.

### Fixed
- Pool services bind on IPv6 (`::`) for Fly 6PN / proxy reachability.
- Runner-serve configures the git committer identity before invoking `kody run`.

## [0.4.109] — review architecture

### Added
- `review-architecture` subagent and a STRIDE-based security review pass.

## [0.4.107] — working discipline

### Added
- Working-discipline block and subagent status discipline.
- Systematic-debugging skill.

## [0.4.106] — subagent wiring

### Added
- Subagent wiring across executables with delivery-ROI improvements.

## [0.4.99] — task artifacts

### Added
- Task artifacts: chat replies commit `backend task artifacts/<sessionId>/`.

## [0.4.96] — agent-ask

### Added
- `agent-ask` ad-hoc executable.

## [0.4.77] — bin rename

### Changed
- Renamed the published binary `kody` → `kody-engine`.

## [0.4.76] — chat catalog

### Added
- Chat catalog of executables.

## [0.4.75] — template pin

### Changed
- Pin `templates/kody.yml` to its own engine version; dropped pip caching.

## [0.4.33] — typed outcomes

### Added
- Typed outcome surfaces unrecognized `@kody` tokens back to the user instead of
  silently routing to the default executable.

### Fixed
- Verify reruns on flake to catch non-deterministic test failures.

## [0.4.31] — typed PR contract

### Fixed
- Typed `PrOutcome` contract eliminates the `PR opened: undefined` message.

## [0.4.29] — evidence-based completion

### Changed
- Executor derives task completion from observable evidence, not agent
  self-report.

## [0.2.0] — initial public line

- First published version. (`0.1.x` was taken on npm by a deprecated
  predecessor, so the project started at `0.2.0`.)

[Unreleased]: https://github.com/aharonyaircohen/kody-engine/compare/v0.4.120...HEAD
[0.4.110]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.110
[0.4.109]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.109
[0.4.107]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.107
[0.4.106]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.106
[0.4.99]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.99
[0.4.96]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.96
[0.4.77]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.77
[0.4.76]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.76
[0.4.75]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.75
[0.4.33]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.33
[0.4.31]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.31
[0.4.29]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.4.29
[0.2.0]: https://github.com/aharonyaircohen/kody-engine/releases/tag/v0.2.0
