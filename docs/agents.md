# Agent

Agents are the company layer's **who**.

An agent file defines identity only. It describes the agent running work:
judgment, tone, priorities, and hard behavioral boundaries. It does not define
concrete responsibilities, cadence, tools, or output contracts. Those belong in
duties and executables.

## Canonical Shape

Agents live in project `.kody/agents/` or in the company store:

```text
.kody/agents/<slug>.md
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

Agent files are prose, but they must answer these questions:

| Question | Required | Meaning |
| --- | --- | --- |
| Who is this? | yes | Agent identity and role. |
| What judgment does this agent bring? | yes | Priorities and taste. |
| What boundaries must never be crossed? | yes | Safety constraints. |
| What work does this agent own? | no | Broad capability only. Concrete work belongs in duties. |

## How Agent Are Used

A duty or executable may declare `agent`. When set, the executor loads
`.kody/agents/<slug>.md` from the project or company store and injects the
authoritative identity before the executable prompt.

If the agent file is missing, the run should fail instead of silently falling
back.

Resolution order:

1. Project `.kody/agents/<slug>.md`
2. Company store `.kody/agents/<slug>.md`

Project agent override store agent.

## Creating A Agent Member

Use this checklist:

1. Create agent only when the work needs a distinct judgment profile.
2. Pick a stable slug, such as `qa`, `cto`, `coo`, or `tech-writer`.
3. Write identity, qualities, and hard boundaries.
4. Keep commands, schedules, and output formats out of the agent file.
5. Wire the agent through duties or executables with `agent`.
6. Prefer reusable store agent; use project agent only for project-specific identity.

## Do Not

- Do not put task instructions in agent.
- Do not put executable commands in agent.
- Do not put cadence scheduling in agent.
- Do not create agent for every duty if an existing agent fits.
- Do not let agent override safety rules from `AGENTS.md`, executable profiles, or duty restrictions.
