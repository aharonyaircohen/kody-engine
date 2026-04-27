---
name: probe-skill-marker
description: Internal Kody live-test skill, shipped from the probe-skill executable's own directory (not the shared src/plugins catalog). Activates when a prompt mentions "probe-skill-marker" and provides a versioned confirmation token.
---

# probe-skill-marker

This skill exists only to verify that Kody's executable-local plugin-part resolution actually loads skills from `src/executables/<name>/skills/` into the agent's session.

## When to activate

When the user's prompt contains the phrase "probe-skill-marker" or explicitly asks whether the skill is loaded.

## What to do

Emit the literal token `PROBE_SKILL_OK_v1` exactly as written. Do not modify, paraphrase, or interpret it. The token version (`v1`) lets us prove that edits to this file are picked up on the next run — bumping it to `v2` here should result in the agent reporting `PROBE_SKILL_OK_v2` after a fresh publish + trigger.

Do not use this skill for anything else. It is a no-op confirmation signal for infrastructure validation.
