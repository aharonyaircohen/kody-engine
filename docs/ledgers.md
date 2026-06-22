# Ledgers

Kody has ledgers, but they are not all the same kind of storage.

## Current Ledgers

| Ledger | Storage | Owner | Purpose |
| --- | --- | --- | --- |
| Trust ledger | `<statePath>/state/trust.json` in `stateRepo` | dashboard writes, engine reads | Current gate for agentResponsibility autonomy: `ask` or `auto`. |
| AgentResponsibility state | `<statePath>/agent-responsibilities/<slug>/state.json` in `stateRepo` | engine | Per-agentResponsibility cursor/data/done and dedup data. |
| Task job/run ledger | `<statePath>/tasks/<issues-or-prs>/<number>/state.json` in `stateRepo` | engine | Required jobs, run attempts, outcomes, history. |
| Goal instance state | `<statePath>/goals/instances/<id>/state.json` in `stateRepo` | engine/dashboard | Managed goal progress. |
| Run events | local runtime scratch (`KODY_RUNTIME_DIR` or OS temp) | engine | Execution trace/debug history. |

## Trust Ledger

The current trust gate is agentResponsibility-keyed:

```json
{
  "version": 1,
  "agent-responsibilities": {
    "pr-health-triage": {
      "approvals": 10,
      "rejections": 0,
      "consecutiveApprovals": 10,
      "mode": "auto"
    }
  },
  "log": []
}
```

The engine reads this file before locked agentResponsibility tools dispatch work. If the agentResponsibility
is in `ask` mode, dispatch tools refuse and tell the agentResponsibility to recommend the
action to the operator instead. Inbox verdict history lives in the trust
ledger's `log`. `qa-engineer` and `ui-review` are read-only exceptions.

## What Is Not A Ledger

`.kody/context` is not a ledger. It is background/orientation.

`.kody/reports` are not ledgers. They are generated snapshots and findings.

## Rule Of Thumb

- Context: what this repo/company is.
- Reports: what is true right now.
- Ledgers: what was decided or what state must persist.
- AgentResponsibilities: what recurring responsibility exists.
- AgentActions: how work actually runs.
