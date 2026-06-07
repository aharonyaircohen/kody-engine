---
staff: [kody]
---

# Plan: AI Company Orchestration — Contracts & Enforcement

## Goal
Turn 7 loose conventions into enforced contracts, built into the dashboard, for repos running in "AI company" mode. No engine changes.

## The 7 Gaps

1. **Trigger-duty-to-staff contract** — each CEO/Chief duty needs explicit: reads-from, prompt, writes-to, done-when. Currently loose.
2. **Multi-section shared ledger** — trust ledger is one slice. Need: priorities, domain state, blockers, decisions.
3. **Aggregated report layer** — a duty that reads all chief reports and produces one CEO report.
4. **Write-back channel for CEO decisions** — where CEO's verdict lands so chiefs can act.
5. **Report schema** — every duty's report needs the same fields.
6. **The "done" claim on the queue** — workers marking done without a claim step means duplicates and race conditions.
7. **Escalation path between layers** — Worker → Chief → CEO. Who escalates what, when, how.

## The Model (recap)

- **Layer 1 (CEO) = staff** (judgment, holds context, can be @-mentioned in chat) + duty (trigger on cadence)
- **Layer 2 (Chiefs) = staff** (judgment, domain decisions) + duty (trigger)
- **Layer 3 (Workers) = duty only** (5-min queue pull, no context held)

**The line:** judgment = staff, execution = duty.

## Key Design Decisions

### 1. Duty-to-Staff Contract
Add structured `contract:` block to duty frontmatter:
```yaml
contract:
  staff: chief-of-engineering
  reads_from:
    - ledger://priorities
    - ledger://blockers
  prompt: "Review blockers, reassign workers, report status"
  writes_to:
    - ledger://domain-state/engineering
    - report://chief/engineering/daily
  done_when: "report committed AND ledger section updated"
```
Dashboard form requires these fields for `role: chief` or `role: ceo` duties. Validates references resolve.

### 2. Multi-Section Shared Ledger
A ledger = named GitHub issue with fixed frontmatter schema. Dashboard indexes by label `ledger:<section>`.

Sections (v1):
| Section | Owner | Writers |
|---|---|---|
| `priorities` | CEO | CEO only |
| `domain-state/<chief>` | Each chief | That chief only |
| `blockers` | Any chief | Any chief, any worker (via chief) |
| `decisions` | CEO | CEO, chiefs (their domain) |

Permission rules: workers can read all, write only to `blockers` (via chief).

### 3. Aggregated Report Layer
A `report-aggregator` duty — reads all `report://chief/*`, writes one `report://ceo/weekly.md`. Runs on CEO's cadence. Auto-created when "AI company" mode is enabled.

### 4. Write-Back Channel
CEO writes to `ledger://priorities` as canonical channel. Posts diff comment on each affected chief's `domain-state` ledger: "Priorities changed: P0 shifted from X to Y."

### 5. Report Schema
`.kody/reports/_schema.yaml` defines required frontmatter:
```yaml
required:
  - id
  - duty_slug
  - role: worker | chief | ceo
  - ran_at
  - status: success | partial | failed
  - summary
  - actions_taken
  - blockers
  - next_steps
```
Dashboard validates. Versioned via `schema_version`.

### 6. Done-Claim Protocol
Two-step protocol using comment markers:
- Claim: `<!-- claim: <worker-slug> at <ts> -->`
- Done: `<!-- done: <worker-slug> at <ts -->`

Chief/aggregator sees "claimed" if `claim` exists without matching `done`. Stale claims (older than N hours) flagged for re-claim.

### 7. Escalation Path
Three markers, scoped by layer:
| From → To | Marker |
|---|---|
| Worker → Chief | `<!-- escalate-to-chief: <reason> -->` |
| Chief → CEO | `<!-- escalate-to-ceo: <reason> -->` |
| Any → Human | `<!-- escalate-to-human: <reason> -->` |

Escalations live in `ledger://blockers` (or `ledger://escalations`). Dashboard rejects worker→CEO direct escalation.

## Implementation Order

1. **Report schema** (#5) — smallest, blocks #3
2. **Ledger sections** (#2) — reuse trust ledger pattern
3. **Done-claim protocol** (#6) — small
4. **Escalation markers** (#7) — depends on #2
5. **Duty-to-staff contract** (#1) — the form/template
6. **Aggregated report layer** (#3) — depends on #1 + #5
7. **Write-back channel** (#4) — depends on #2 + #3

## Where the Work Lives

| Gap | Dashboard page | Consumer repo file | Engine change |
|---|---|---|---|
| #1 Contract | "Duties" form | `.kody/duties/<slug>.md` | None |
| #2 Ledger | "Ledgers" view | Issues with `ledger:*` label | None |
| #3 Aggregator | "Reports" view | New duty from template | None |
| #4 Write-back | "Priorities" view | `ledger://priorities` issue | None |
| #5 Schema | "Reports" validation | `.kody/reports/_schema.yaml` | None |
| #6 Claim | "Queues" view | Issue comments with markers | None |
| #7 Escalation | "Blockers" view | `ledger://blockers` issue | None |

**Zero engine changes. All dashboard + consumer repo.**

## Open Questions

1. **Schema ownership** — dashboard owns template, repo can override (my pick)
2. **Ledger conflict resolution** — append-only with timestamps, dashboard renders chronologically (my pick)
3. **Human override** — separate "human decisions" section, supersedes CEO (my pick)
4. **Stale claim timeout** — 4 hours default, configurable per consumer repo (my pick)

## Related Context

- The trust ledger duty already exists in some consumer repos — it's a single-section ledger and should be generalized into the multi-section scheme.
- The current engine has all needed primitives: staff, duty, report, comment-routing. No engine changes required.
- Dashboard is the right enforcement layer (per-repo, opt-in "AI company" mode) — engine is generic infrastructure, adding AI-company primitives would bloat it.
