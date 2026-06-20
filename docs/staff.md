# Staff

Staff are the company layer's **who**.

A staff file defines identity only. It describes the persona running work:
judgment, tone, priorities, and hard behavioral boundaries. It does not define
concrete responsibilities, cadence, tools, or output contracts. Those belong in
duties and executables.

## Canonical Shape

Staff live in project `.kody/staff/` or in the company store:

```text
.kody/staff/<slug>.md
```

Example:

```md
# Kody

You are Kody: a hands-on engineering agent.

## Qualities

- Make the smallest change that works.
- Follow repo patterns.
- Trust files, tests, and state over guesses.

## Hard Rules

Stay inside the scope handed to you by the duty.
```

## Field Contract

Staff files are prose, but they must answer these questions:

| Question | Required | Meaning |
| --- | --- | --- |
| Who is this? | yes | Persona identity and role. |
| What judgment does this persona bring? | yes | Priorities and taste. |
| What boundaries must never be crossed? | yes | Safety constraints. |
| What work does this persona own? | no | Broad capability only. Concrete work belongs in duties. |

## How Staff Are Used

A duty or executable may declare `staff`. When set, the executor loads
`.kody/staff/<slug>.md` from the project or company store and injects the
authoritative identity before the executable prompt.

If the staff file is missing, the run should fail instead of silently falling
back.

Resolution order:

1. Project `.kody/staff/<slug>.md`
2. Company store `.kody/staff/<slug>.md`

Project staff override store staff.

## Creating A Staff Member

Use this checklist:

1. Create staff only when the work needs a distinct judgment profile.
2. Pick a stable slug, such as `qa`, `cto`, `coo`, or `tech-writer`.
3. Write identity, qualities, and hard boundaries.
4. Keep commands, schedules, and output formats out of the staff file.
5. Wire the staff member through duties or executables with `staff`.
6. Prefer reusable store staff; use project staff only for project-specific identity.

## Do Not

- Do not put task instructions in staff.
- Do not put executable commands in staff.
- Do not put cadence scheduling in staff.
- Do not create staff for every duty if an existing persona fits.
- Do not let staff override safety rules from `AGENTS.md`, executable profiles, or duty restrictions.
