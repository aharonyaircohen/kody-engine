# Ledgers

Kody has ledgers, but they are not all the same kind of storage.

## Current Ledgers

| Ledger | Storage | Owner | Purpose |
| --- | --- | --- | --- |
| Trust ledger | `.kody/state/trust.json` on `kody-state` | dashboard writes, engine reads | Current gate for duty autonomy: `ask` or `auto`. |
| Duty state | duty state backend / sidecar state | engine | Per-duty cursor/data/done and dedup data. |
| Task job/run ledger | task state on issue/PR | engine | Required jobs, run attempts, outcomes, history. |
| Goal instance state | `.kody/goals/instances/<id>/state.json` on `kody-state` | engine/dashboard | Managed goal progress. |
| Run events | `.kody/runs/<runId>/events.jsonl` | engine | Execution trace/debug history. |

## Trust Ledger

The current trust gate is duty-keyed:

```json
{
  "version": 1,
  "duties": {
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

The engine reads this file before locked duty tools dispatch work. If the duty
is in `ask` mode, dispatch tools refuse and tell the duty to recommend the
action to the operator instead. Inbox verdict history lives in the trust
ledger's `log`. `qa-engineer` and `ui-review` are read-only exceptions.

## What Is Not A Ledger

`.kody/context` is not a ledger. It is background/orientation.

`.kody/reports` are not ledgers. They are generated snapshots and findings.

## Rule Of Thumb

- Context: what this repo/company is.
- Reports: what is true right now.
- Ledgers: what was decided or what state must persist.
- Duties: what recurring responsibility exists.
- Executables: how work actually runs.
