# Engine Company

This doc describes the repo-local company layer used to maintain
`@kody-ade/kody-engine`.

The company layer is not the engine itself. It sits in `.kody/` and helps watch,
route, verify, and explain engine work.

## Core Rule

Company layer coordinates. Engine primitives execute.

Do not duplicate built-in engine executables like `run`, `fix`, `fix-ci`,
`sync`, `resolve`, `merge`, or `release`. Company executables should inspect,
decide, report, or dispatch those primitives.

## Pieces

| Piece | Path | Purpose |
| --- | --- | --- |
| Staff | `.kody/staff/<slug>.md` | Who is acting. Persona only. |
| Duties | `.kody/duties/<slug>/` | Recurring responsibility: cadence, owner, intent. |
| Company executables | `.kody/executables/<slug>/` | Repo-local actions for inspection, reports, triage, and dispatch. |
| Reports | `.kody/reports/*.md` | Shared state and findings. |
| Context | `.kody/context/*.md` | Short background and vocabulary. Not hard rules. |
| Goals | `.kody/goals/<id>/state.json` | Related task chains when larger work needs stacked PRs. |

For ledger storage and trust gates, see [ledgers.md](ledgers.md).

## Where Rules Live

- `AGENTS.md` / `CLAUDE.md`: hard constraints and repo conventions.
- `docs/engine-company.md`: this operating model.
- `.kody/context/*.md`: short orientation for company agents.
- `.kody/staff/*.md`: identity only.
- `.kody/duties/<slug>/duty.md`: recurring intent.
- `.kody/executables/<slug>/skills/*/SKILL.md`: exact method and allowed actions.

`.kody/context` is not loaded by every engine executable. Treat it as background
for company coordination, not as execution policy.

## Recommended Staff

- `coo`: queues, briefing, stuck work, coordination.
- `cto`: architecture, invariants, PR safety, release safety.
- `qa`: live verification and regression checks.
- `tech-writer`: docs drift and terminology clarity.
- `kody`: implementation through built-in engine primitives.

## Recommended Company Executables

Start small:

1. `engine-briefing`: summarize issues, PRs, CI, releases, reports, and goals.
2. `engine-pr-triage`: find PRs that need `fix-ci`, `sync`, or `resolve`.
3. `engine-invariant-audit`: check executor/profile/script invariants.

Add later:

- `engine-ci-health`
- `engine-release-readiness`
- `engine-live-verify`
- `engine-docs-drift`

## Healthy Engine

The engine is healthy when:

- CI is green.
- Core executables work end to end.
- Duties dispatch safely.
- Releases are verified live.
- Docs match implemented behavior.
- Engine invariants stay intact.

## Design Bias

Prefer small company executables with clear authority. A good company executable
does one of four things:

- inspect
- report
- recommend
- dispatch a built-in primitive

It should not silently perform risky product, architecture, release, or merge
decisions without an explicit trust gate.
