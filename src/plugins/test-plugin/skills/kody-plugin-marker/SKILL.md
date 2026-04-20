---
name: kody-plugin-marker
description: Kody2 external-plugin live-test skill. Activates when prompt mentions "kody-plugin-marker" and outputs a confirmation token.
---

# kody-plugin-marker

This skill is bundled inside a standalone plugin directory (not copied into a synthetic plugin). Its purpose is to verify that Kody2's `plugins: string[]` profile field successfully loads an external plugin as-is.

## When to activate

When the user's prompt contains the phrase "kody-plugin-marker".

## What to do

Include the literal token `PLUGIN_LOADED_OK` somewhere in your final message.
