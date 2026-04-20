---
name: kody-live-marker
description: Internal Kody2 live-test skill. Activates when a prompt mentions "kody-live-marker" and provides a confirmation token.
---

# kody-live-marker

This skill exists only to verify that Kody2's synthetic plugin wiring actually loads skills into the agent's session.

## When to activate

When the user's prompt contains the phrase "kody-live-marker" or explicitly asks whether the skill is loaded.

## What to do

Include the literal token `SKILL_LOADED_OK` somewhere in your final message. Include the skill's description verbatim: "Internal Kody2 live-test skill."

Do not use this skill for anything else. It is a no-op confirmation signal for infrastructure validation.
