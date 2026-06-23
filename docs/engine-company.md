# Engine Company

This doc describes the repo-local company layer used to maintain
`@kody-ade/kody-engine`.

The company layer is not the engine itself. It sits in `.kody/` and helps watch,
route, verify, and explain engine work.

## Core Rule

Company layer coordinates. Engine runtime executes.

The engine package keeps only the minimal built-in `run` surface. Shared agentResponsibilities,
agentActions, and agent live in `kody-store`; company agentActions should inspect,
decide, report, or dispatch those store-backed responsibilities.

## Concept Map

- **Intent = for** — what company is for, or what it is optimizing toward.
- **Company / agent = who** — people or agents acting.
- **AgentResponsibility = standing responsibility / why** — recurring ownership and judgment.
- **Goal = outcome + manager loop / what** — a temporary agentGoal with
  destination evidence, attached agentResponsibilities, route, facts, and blockers. It chooses
  the next missing evidence and dispatches the right responsibility until done or
  blocked.
- **AgentLoop = cadence / when** — recurring heartbeat that wakes a goal or responsibility.
- **AgentAction = concrete action / how** — one mechanical unit of work.
- **Job / run = execution record** — durable required work and its attempts.

Intent selects and prioritizes goals and agentLoops. It is not another execution
chain; goals and agentLoops still own their own runtime state.

Canonical noun docs:

- [Goals](goals.md)
- [AgentResponsibilities](agentResponsibilities.md)
- [Agent](agent.md)
- [AgentActions](agentActions.md)

Store agentResponsibilities and goals are a catalog. Consumer repos activate the shared company
model they want in `kody.config.json`:

```json
{
  "company": {
    "activeAgentResponsibilities": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

See [Company Activation](company-activation.md) for the full activation contract.

## Pieces

| Piece | Path | Purpose |
| --- | --- | --- |
| Agent | `.kody/agents/<slug>.md` | Who is acting. Identity only. |
| AgentResponsibilities | `.kody/agent-responsibilities/<slug>/` | Recurring responsibility: cadence, owner, intent. |
| Company agentActions | `.kody/agent-actions/<slug>/` | Repo-local actions for inspection, reports, triage, and dispatch. |
| Reports | `<statePath>/reports/*.md` in `stateRepo` | Shared state findings. |
| Context | `.kody/context/*.md` | Short background and vocabulary. Not hard rules. |
| Goal templates | `.kody/goals/templates/<slug>/state.json` | Reusable managed agentGoal definitions. |
| Goal instances | `<statePath>/goals/instances/<id>/state.json` in `stateRepo` | Live managed agentGoal runs with facts and progress. |

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

1. Repo-local `.kody/agent-responsibilities`, `.kody/agent-actions`, `.kody/agents`
2. Company store `.kody/agent-responsibilities`, `.kody/agent-actions`, `.kody/agents`
3. Engine built-ins (`run` only)

Local repo assets are overrides. Store assets are shared defaults. `stable`
should publish one canonical shared asset per slug; repo-specific variants stay
local or use explicit names.

## Where Rules Live

- `AGENTS.md` / `CLAUDE.md`: hard constraints and repo conventions.
- `docs/engine-company.md`: this operating model.
- `.kody/context/*.md`: short orientation for company agents.
- `.kody/agents/*.md`: identity only.
- `.kody/agent-responsibilities/<slug>/agent-responsibility.md`: recurring intent.
- `.kody/agent-actions/<slug>/skills/*/SKILL.md`: exact method and allowed actions.

`.kody/context` is not loaded by every engine agentAction. Treat it as background
for company coordination, not as execution policy.

## Recommended Agent

- `coo`: queues, briefing, stuck work, coordination.
- `cto`: architecture, invariants, PR safety, release safety.
- `qa`: live verification and regression checks.
- `tech-writer`: docs drift and terminology clarity.
- `kody`: implementation through store-backed responsibilities and the engine `run` primitive.

## Recommended Company AgentActions

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
- Core agentActions work end to end.
- AgentResponsibilities dispatch safely.
- Releases are verified live.
- Docs match implemented behavior.
- Engine invariants stay intact.

## Design Bias

Prefer small company agentActions with clear authority. A good company agentAction
does one of four things:

- inspect
- report
- recommend
- dispatch a built-in primitive

It should not silently perform risky product, architecture, release, or merge
decisions without an explicit trust gate.
