# task-leader duty — tick at 2026-06-19T19:57Z

## Status
No-op tick — **3rd consecutive blocker**.

## Blocker
`.kody/executables/task-leader/skills/task-leader-rules/SKILL.md` is missing locally.
The `.kody/executables/task-leader/` directory does not exist; only `release-*` executables are checked in.

The duty body requires reading and following this rules file exactly. It owns:
- 6-step method
- Normal small-PR gate
- Release version PR gate
- Release promotion PR gate
- Final output format

Without the rules file, the duty contract is undefined. Per the duty's Restrictions ("Do not perform actions outside the contract defined by this duty"), every intended action (request review, request fix, auto-merge, dispatch, escalate) is out of contract, so the safe path is no-op.

## Operator action needed
Land `.kody/executables/task-leader/skills/task-leader-rules/SKILL.md` (and a `task-leader` executable directory if the engine expects one) so the duty can act on its next wake.
