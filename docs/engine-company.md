# Engine Company

This doc describes the repo-local company layer used to maintain
`@kody-ade/kody-engine`.

The company layer is not the engine itself. It sits in `.kody/` and helps watch,
route, verify, and explain engine work.

## Core Rule

Company layer coordinates. Engine runtime executes.

The engine package keeps only the minimal built-in `run` surface. Shared capabilities,
implementation profiles, and agents live in `kody-store`; company implementations
should inspect, decide, report, or dispatch those store-backed capabilities.

## Concept Map

The canonical model is:

- **Intent = why** — company direction, optional deeper context, priority, posture, scope, and success signals.
- **Goal = what** — durable outcome state with destination evidence, route, facts, and blockers. It chooses
  the next missing evidence and dispatches the right capability until done or
  blocked.
- **AgentLoop = when** — recurring heartbeat that wakes a goal or capability.
- **Agent = who** — reusable identity and judgment style.
- **Capability = how** — reusable ability the agency can use.
- **Job / run = execution record** — durable required work and its attempts.

Current storage names:

- **Capability = capability contract** — public action, kind, owner,
  cadence, safety, inputs, outputs, and implementation link.
- **Implementation profile = capability implementation** — one concrete runnable unit
  with prompts, tools, skills, scripts, and executor profile, stored in a capability folder.

Intent selects and prioritizes goals and agentLoops. It is not another execution
chain; goals and agentLoops still own their own runtime state.

## CTO agency architect

The first agency architect is `cto`, running the `agency-architect` capability.
It reads active intent files under `<statePath>/intents/<id>/intent.json`,
compares them with current goal/loop state, and applies validated portfolio
actions. This is portfolio orchestration: creating, linking, pausing, or
resuming goals and agentLoops so the agency serves active intent.

Intent may include a `description` for deeper context and lightweight `metrics`
names. Description helps CTO interpret the one-line direction; metrics are not
a separate model in v1 and tell CTO how intent should be judged.

Canonical noun docs:

- [Goals](goals.md)
- [Capabilities](capabilities.md)
- [Agent](agents.md)
- [Implementation Profiles](executables.md)

Store capabilities and goals are a catalog. Consumer repos activate the shared company
model they want in `kody.config.json`:

```json
{
  "company": {
    "activeCapabilities": ["release"],
    "activeGoals": ["web-release"]
  }
}
```

See [Company Activation](company-activation.md) for the full activation contract.

## Pieces

| Piece | Path | Purpose |
| --- | --- | --- |
| Agent | `.kody/agents/<slug>.md` | Who is acting. Identity only. |
| Capabilities | `.kody/capabilities/<slug>/` | Capability contracts: public action, kind, cadence, owner, and output contract. |
| Capability implementations | `.kody/capabilities/<slug>/` with `role` | Capability implementations for inspection, reports, triage, and dispatch. |
| Reports | `<statePath>/reports/<slug>/runs/*.md` in `stateRepo` | Goal/loop-owned state findings for Dashboard display. |
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

1. Repo-local `.kody/capabilities`, `.kody/agents`
2. Company store `.kody/capabilities`, `.kody/agents`
3. Engine built-ins (`run` only)

Local repo assets are overrides. Store assets are shared defaults. `stable`
should publish one canonical shared asset per slug; repo-specific variants stay
local or use explicit names.

## Where Rules Live

- `AGENTS.md` / `CLAUDE.md`: hard constraints and repo conventions.
- `docs/engine-company.md`: this operating model.
- `.kody/context/*.md`: short orientation for company agents.
- `.kody/agents/*.md`: identity only.
- `.kody/capabilities/<slug>/capability.md`: recurring intent.
- `.kody/capabilities/<slug>/skills/*/SKILL.md`: exact method and allowed actions.

`.kody/context` is not loaded by every engine implementation. Treat it as background
for company coordination, not as execution policy.

## Recommended Agent

- `coo`: queues, briefing, stuck work, coordination.
- `cto`: architecture, invariants, PR safety, release safety.
- `qa`: live verification and regression checks.
- `tech-writer`: docs drift and terminology clarity.
- `kody`: implementation through store-backed capabilities and the engine `run` primitive.

## Recommended Company Implementations

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
- Capabilities dispatch safely.
- Releases are verified live.
- Docs match implemented behavior.
- Engine invariants stay intact.

## Design Bias

Prefer small company implementations with clear authority. A good company implementation
does one of four things:

- inspect
- report
- recommend
- dispatch a built-in primitive

It should not silently perform risky product, architecture, release, or merge
decisions without an explicit trust gate.
