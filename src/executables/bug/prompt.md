<!--
This file exists only because the executor's profile loader expects a
prompt.md sibling. The orchestrator-plan-build-review executable runs
with maxTurns: 0 and a `skipAgent` preflight, so this prompt is never
actually delivered to Claude. The transition logic lives entirely in
profile.json's postflight entries.
-->
