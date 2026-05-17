#!/usr/bin/env bash
#
# goal-scheduler: enumerate every goal state file under .kody/goals/ and
# dispatch goal-tick once for each whose state == "active". Runs as a
# scheduled executable (cron `*/5 * * * *`). No agent.
#
# A failed individual tick logs and continues — one stuck goal must not
# starve the rest.

set -euo pipefail

goals_dir=".kody/goals"

if [ ! -d "$goals_dir" ]; then
  echo "[goal-scheduler] no $goals_dir — nothing to schedule"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

shopt -s nullglob
state_files=("$goals_dir"/*/state.json)
shopt -u nullglob

if [ "${#state_files[@]}" = "0" ]; then
  echo "[goal-scheduler] no goal state files yet"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

active=0
for state_file in "${state_files[@]}"; do
  [ -f "$state_file" ] || continue
  goal_id=$(basename "$(dirname "$state_file")")

  state=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('state',''))" "$state_file" 2>/dev/null || echo "")

  if [ "$state" != "active" ]; then
    continue
  fi

  active=$((active + 1))
  echo "[goal-scheduler] → tick $goal_id"

  # NOTE: the shared goal branch is created lazily by goal-tick at the moment
  # it's about to dispatch the first task. Goals whose ticks never dispatch
  # (e.g. all tasks closed as won't-fix, or every task carries goal-runner:failed)
  # never spawn an orphan goal-<id> ref on origin. The trade-off vs. the prior
  # eager creation: the goal branch's base is "origin/<defaultBranch> at first
  # dispatch" rather than "origin/<defaultBranch> at goal activation", which
  # is better for short-lived QA-style goals where main may have moved on.

  # Run the tick. The published CLI bin is `kody-engine` (see package.json
  # "bin") — NOT `kody`. Calling bare `kody` here failed with
  # `kody: command not found`, so every active goal silently failed to
  # advance. `kody-engine` is on PATH because the workflow invokes the
  # engine via `npx -p @kody-ade/kody-engine ... kody-engine`, and child
  # processes inherit that PATH. A non-zero exit logs and continues so one
  # stuck goal doesn't starve the rest of the schedule.
  if ! kody-engine goal-tick --goal "$goal_id"; then
    echo "[goal-scheduler] tick $goal_id failed (continuing)"
  fi
done

echo "[goal-scheduler] ticked $active active goal(s) of ${#state_files[@]} total"
echo "KODY_SKIP_AGENT=true"
exit 0
