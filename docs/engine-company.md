# Engine Company

This doc describes the repo-local company layer used to maintain
`@kody-ade/kody-engine`.

The company layer is not the engine itself. It sits in `.kody/` and helps watch,
route, verify, and explain engine work.

## Core Rule

Company layer coordinates. Engine runtime executes.

The engine package keeps only the minimal built-in `run` surface. Shared duties,
executables, and staff live in `kody-store`; company executables should inspect,
decide, report, or dispatch those store-backed responsibilities.

## Concept Map

- **Company / staff = who** — people or personas acting.
- **Duty = standing responsibility / why** — recurring ownership and judgment.
- **Goal = outcome + manager loop / what** — a temporary objective with
  destination evidence, attached duties, route, facts, and blockers. It chooses
  the next missing evidence and dispatches the right responsibility until done or
  blocked.
- **Executable = concrete action / how** — one mechanical unit of work.
- **Job / run = execution record** — durable required work and its attempts.

Canonical noun docs:

- [Goals](goals.md)
- [Duties](duties.md)
- [Staff](staff.md)
- [Executables](executables.md)

Store duties and goals are a catalog. Consumer repos activate the shared company
model they want in `kody.config.json`:

```json
{
  "company": {
    "activeDuties": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

See [Company Activation](company-activation.md) for the full activation contract.

## Pieces

| Piece | Path | Purpose |
| --- | --- | --- |
| Staff | `.kody/staff/<slug>.md` | Who is acting. Persona only. |
| Duties | `.kody/duties/<slug>/` | Recurring responsibility: cadence, owner, intent. |
| Company executables | `.kody/executables/<slug>/` | Repo-local actions for inspection, reports, triage, and dispatch. |
| Reports | `.kody/reports/*.md` | Shared state and findings. |
| Context | `.kody/context/*.md` | Short background and vocabulary. Not hard rules. |
| Goal templates | `.kody/goals/templates/<slug>/state.json` | Reusable managed objective definitions. |
| Goal instances | `.kody/goals/instances/<id>/state.json` | Live managed objective runs with facts and progress. |

For ledger storage and trust gates, see [ledgers.md](ledgers.md).

## Company Store

Shared company assets can come from a remote company store before engine
built-ins. Defaults:

```bash
KODY_COMPANY_STORE=aharonyaircohen/kody-company-store
KODY_COMPANY_STORE_REF=stable
```

`KODY_COMPANY_STORE_REF` is a Git ref, so it may be a branch, tag, or SHA.

Resolution order:

1. Repo-local `.kody/duties`, `.kody/executables`, `.kody/staff`
2. Company store `.kody/duties`, `.kody/executables`, `.kody/staff`
3. Engine built-ins (`run` only)

Local repo assets are overrides. Store assets are shared defaults. `stable`
should publish one canonical shared asset per slug; repo-specific variants stay
local or use explicit names.

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
- `kody`: implementation through store-backed responsibilities and the engine `run` primitive.

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
