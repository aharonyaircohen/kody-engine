# Delivery boundary

Kody may inspect the whole checkout, but it does not commit every changed file.
The postflight delivery step separates product work from runtime state and
operator-owned configuration before creating the PR.

## What happens to each kind of change

| Change | Result |
|---|---|
| Normal source, test, or documentation file | Committed and pushed to the task branch |
| Engine-generated cache or runtime state (`.kody-engine/`, `.kody-lean/`, `.codegraph/`, `node_modules/`, `dist/`, `build/`, logs) | Discarded from delivery without failing otherwise valid product work |
| Protected operator or security configuration (`.github/*.yml`, `.env`, `kody.config.json`, legacy `.kody/` state) | Excluded from the commit and reported as a blocked delivery; the run fails visibly instead of claiming full completion |

This distinction matters because definition hydration updates
`.kody-engine/definitions/manifest.json` on normal runs. That file belongs to
the Engine runtime; it is not work the agent attempted to deliver.

## Delivering an approved protected file

Do not weaken the global boundary. A capability that legitimately owns a
GitHub workflow or a repository loop definition must declare the exact path in
its delivery contract. The Engine validates that allowlist and only then stages
the ignored file. Ordinary `run` work cannot opt itself into that permission.

When a requested protected change is blocked, the issue status names the exact
omitted path and the workflow exits nonzero. The PR can still contain the safe
files that were successfully delivered; treat it as partial work until an
approved owner supplies the protected file.
