# Intents

An Intent is the company's **why**: one direction the company has chosen to care about.

## Ownership

An Intent owns:

- the desired company effect;
- priority and operating posture;
- repository and business-area scope;
- principles and measurable success signals;
- automation limits and required human approvals;
- portfolio references and review cadence.

It does not own Operations, Goals, Loops, Capabilities, Workflows, Agents, or execution. Those models must remain independently reviewable.

## Storage

Intent state lives in the configured backend at:

`<statePath>/intents/<id>/intent.json`

The canonical version-1 fields are `version`, `id`, `status`, `for`, optional `description`, `priority`, `posture`, `scope`, `principles`, `metrics`, `policy`, `portfolio`, `manager`, `createdAt`, and `updatedAt`.

`status` is `active`, `paused`, or `archived`. Creator proposals must use `paused`; only explicit human approval may activate a new Intent.

## Creation rule

Create one Intent only when its direction and scope do not already fit an existing Intent. A creator drafts the model and opens a review PR. It never designs the agency response or activates the Intent directly.
