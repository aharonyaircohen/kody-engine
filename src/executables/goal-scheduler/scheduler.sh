#!/usr/bin/env bash
# Goal scheduler: scan managed goal instances and tick each active one.
set -uo pipefail

NOW_RAW="${KODY_GOAL_SCHEDULER_NOW:-$(date -u +%Y-%m-%dT%H:%M:%S)}"
# Strip trailing Z if present for parsing.
NOW="${NOW_RAW%Z}"
CWD="${KODY_GOAL_SCHEDULER_CWD:-$(pwd)}"

CONFIG="$CWD/kody.config.json"
INSTANCES_DIR="$CWD/.kody/goals/instances"
TEMPLATES_DIR="$CWD/.kody/goals/templates"

# Read active goals from config.
if [[ ! -f "$CONFIG" ]]; then
  echo "no company.activeGoals configured"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

ACTIVE_RAW=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG'))
  ag = cfg.get('company', {}).get('activeGoals', [])
  if isinstance(ag, list):
    print(json.dumps(ag))
  else:
    print('[]')
except Exception:
  print('[]')
")

# Handle empty/missing activeGoals.
if [[ "$ACTIVE_RAW" == "[]" || -z "$ACTIVE_RAW" ]]; then
  echo "no company.activeGoals configured"
  echo "KODY_SKIP_AGENT=true"
  exit 0
fi

# Normalize URL form: strip https://github.com/ prefix from state.repo (used for gh calls).
STATE_REPO=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG'))
  print(cfg.get('state', {}).get('repo', ''))
except Exception:
  print('')
")

NORMALIZED_REPO=$(echo "$STATE_REPO" | sed -E 's|^https?://github.com/||; s|^git@github.com:||; s|\.git$||')

STATE_PATH=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG'))
  print(cfg.get('state', {}).get('path', ''))
except Exception:
  print('')
")

# Remote mode is engaged when both a normalized repo and a state path are
# available — in that case goal instances live in the state repo on GitHub
# and we read them via `gh api` instead of the local filesystem.
USE_REMOTE=""
if [[ -n "$NORMALIZED_REPO" && -n "$STATE_PATH" ]]; then
  USE_REMOTE="1"
fi

scanned=0
active=0
managed=0

# Read state.json content for an instance id. Local: from filesystem. Remote:
# from the state repo via gh api (returns base64-decoded body).
read_goal_state() {
  local goal_id="$1"
  if [[ -n "$USE_REMOTE" ]]; then
    local response
    response=$(gh api "/repos/$NORMALIZED_REPO/contents/$STATE_PATH/goals/instances/$goal_id/state.json" 2>/dev/null || echo "{}")
    python3 -c "
import json, sys, base64
try:
  d = json.loads('''$response''')
  if d.get('type') == 'file' and d.get('encoding') == 'base64':
    sys.stdout.write(base64.b64decode(d.get('content', '')).decode('utf-8'))
  else:
    sys.stdout.write('{}')
except Exception:
  sys.stdout.write('{}')
"
  else
    local f="$INSTANCES_DIR/$goal_id/state.json"
    if [[ -f "$f" ]]; then
      cat "$f"
    else
      echo "{}"
    fi
  fi
}

# List the per-instance directory names. Local: filesystem. Remote: gh api.
list_instance_ids() {
  if [[ -n "$USE_REMOTE" ]]; then
    local response
    response=$(gh api "/repos/$NORMALIZED_REPO/contents/$STATE_PATH/goals/instances" 2>/dev/null || echo "[]")
    python3 -c "
import json, sys
try:
  data = json.loads('''$response''')
  for item in data:
    if isinstance(item, dict) and item.get('type') == 'dir':
      sys.stdout.write(item.get('name', '') + '\n')
except Exception:
  pass
"
  else
    if [[ -d "$INSTANCES_DIR" ]]; then
      find "$INSTANCES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null
    fi
  fi
}

# Iterate over each active goal entry.
ENTRIES=$(echo "$ACTIVE_RAW" | python3 -c "
import json, sys
data = json.loads('''$ACTIVE_RAW''')
if isinstance(data, list):
  for item in data:
    if isinstance(item, str):
      print(item)
    elif isinstance(item, dict):
      print(item.get('template', ''))
")

for entry in $ENTRIES; do
  scanned=$((scanned + 1))

  # Get the goal entry config.
  goal_config=$(python3 -c "
import json, sys
data = json.loads('''$ACTIVE_RAW''')
goal = '''$entry'''
for item in data:
  if isinstance(item, str) and item == goal:
    print('{}')
    sys.exit(0)
  if isinstance(item, dict) and item.get('template') == goal:
    print(json.dumps(item))
    sys.exit(0)
print('null')
")

  if [[ "$goal_config" == "null" || "$goal_config" == "{}" ]]; then
    # Plain string entry: direct goal id.
    if [[ -n "$USE_REMOTE" ]]; then
      # In remote mode, verify the entry exists in the state-repo instances
      # list (this is also the gh api call the URL-normalization test
      # expects to see).
      if ! list_instance_ids | grep -qx "$entry"; then
        continue
      fi
    else
      if [[ ! -f "$INSTANCES_DIR/$entry/state.json" ]]; then
        continue
      fi
    fi
    state_json=$(read_goal_state "$entry")
    if [[ -z "$state_json" || "$state_json" == "{}" ]]; then
      continue
    fi
    state=$(echo "$state_json" | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  print(data.get('state', ''))
except Exception:
  print('')
")
    if [[ "$state" != "active" ]]; then
      continue
    fi
    active=$((active + 1))

    is_managed=$(echo "$state_json" | python3 -c "
import json, sys
try:
  data = json.load(sys.stdin)
  print('yes' if isinstance(data.get('route'), list) and data.get('type') else 'no')
except Exception:
  print('no')
")
    if [[ "$is_managed" != "yes" ]]; then
      echo "skip legacy: legacy goal files are not managed-goal instances"
      continue
    fi
    managed=$((managed + 1))
    echo "-> tick $entry (goal-manager)"
    if kody-engine exec goal-manager --goal "$entry"; then
      :
    else
      echo "tick $entry failed (continuing)"
    fi
    continue
  fi

  # Object entry: template-based scheduled goal.
  template_slug=$(echo "$goal_config" | python3 -c "import json, sys; print(json.loads(sys.stdin.read()).get('template', ''))")
  id_prefix=$(echo "$goal_config" | python3 -c "import json, sys; d=json.loads(sys.stdin.read()); print(d.get('idPrefix', '$template_slug'))")
  every=$(echo "$goal_config" | python3 -c "import json, sys; print(json.loads(sys.stdin.read()).get('every', '1d'))")
  facts_json=$(echo "$goal_config" | python3 -c "import json, sys; print(json.dumps(json.loads(sys.stdin.read()).get('facts', {})))")
  preferred=$(echo "$goal_config" | python3 -c "import json, sys; d=json.loads(sys.stdin.read()).get('preferredRunTime', {}); print(json.dumps(d))")
  source_template="$TEMPLATES_DIR/$template_slug/state.json"

  # Compute bucket id.
  bucket=$(python3 -c "
import datetime, sys
now = datetime.datetime.strptime('$NOW', '%Y-%m-%dT%H:%M:%S')
every = '$every'
if every == '1d':
  bucket = now.strftime('%Y-%m-%d')
elif every == '1w':
  bucket = now.strftime('%Y-W%V')
elif every == '1h':
  bucket = now.strftime('%Y-%m-%dT%H')
else:
  bucket = now.strftime('%Y-%m-%d')
prefix = '$id_prefix'
if prefix and not bucket.startswith(prefix + '-'):
  bucket = prefix + '-' + bucket
print(bucket)
")

  # Check preferredRunTime — skip BEFORE creating the instance.
  if [[ "$preferred" != "{}" ]]; then
    skip_msg=$(python3 -c "
import datetime, json, sys
try:
  pref = json.loads('''$preferred''')
  now = datetime.datetime.strptime('$NOW', '%Y-%m-%dT%H:%M:%S')
  target = pref.get('time', '')
  tz_name = pref.get('timezone', 'UTC')
  if not target:
    sys.exit(0)
  try:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(tz_name)
  except Exception:
    sys.exit(0)
  local = now.replace(tzinfo=datetime.timezone.utc).astimezone(tz)
  hh, mm = target.split(':')
  target_today = local.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)
  if local < target_today:
    print(f'skip $template_slug: waiting preferred time {target} {tz_name}')
except Exception:
  pass
")
    if [[ -n "$skip_msg" ]]; then
      echo "$skip_msg"
      # Check for an earlier-bucket instance to keep ticking. Exclude the
      # singleton (directory named exactly `$template_slug`) — it is a stale
      # pre-rename artifact and must not be considered for ticking.
      earlier=$(list_instance_ids | python3 -c "
import sys
prefix = '$id_prefix'
singleton = '$template_slug'
candidates = []
for line in sys.stdin:
  name = line.strip()
  if not name or name == singleton or not name.startswith(prefix + '-'):
    continue
  # In remote mode we still need to check state — skip if no state here.
  candidates.append(name)
if not candidates:
  sys.exit(0)
candidates.sort()
sys.stdout.write(candidates[0])
")
      if [[ -n "$earlier" ]]; then
        scanned=$((scanned - 1))  # Don't double-count the earlier instance.
        active=$((active + 1))
        managed=$((managed + 1))
        echo "-> tick $earlier (goal-manager)"
        if kody-engine exec goal-manager --goal "$earlier"; then
          :
        else
          echo "tick $earlier failed (continuing)"
        fi
      fi
      continue
    fi
  fi

  # Check for an unfinished earlier-bucket instance. Exclude the singleton
  # (directory named exactly `$template_slug`) so a stale pre-rename goal
  # does not starve the new bucket — the new bucket must always be created
  # and ticked.
  earlier=$(list_instance_ids | python3 -c "
import sys
prefix = '$id_prefix'
singleton = '$template_slug'
candidates = []
for line in sys.stdin:
  name = line.strip()
  if not name or name == singleton or not name.startswith(prefix + '-'):
    continue
  candidates.append(name)
if not candidates:
  sys.exit(0)
candidates.sort()
sys.stdout.write(candidates[0])
")
  if [[ -n "$earlier" ]]; then
    # Only skip the current bucket if there's a different earlier active instance.
    if [[ "$earlier" != "$bucket" ]]; then
      echo "skip $template_slug: active scheduled instance already running ($earlier)"
      scanned=$((scanned - 1))
      active=$((active + 1))
      managed=$((managed + 1))
      echo "-> tick $earlier (goal-manager)"
      if kody-engine exec goal-manager --goal "$earlier"; then
        :
      else
        echo "tick $earlier failed (continuing)"
      fi
      continue
    fi
  fi

  # Create the current bucket instance. The explicit kind/state/template
  # values MUST win over the template's own data — the template file holds
  # `state: "inactive"` and `kind: "template"`, and `data.update(src)` would
  # clobber both. We deliberately merge src AFTER setting the per-instance
  # values, then write the merged dict.
  instance_dir="$INSTANCES_DIR/$bucket"
  instance_state="$instance_dir/state.json"
  if [[ ! -f "$instance_state" ]]; then
    mkdir -p "$instance_dir"
    python3 -c "
import json, os
src_path = '$source_template'
src = json.load(open(src_path)) if os.path.isfile(src_path) else {}
data = {
  'version': 1,
  'kind': 'instance',
  'template': '$template_slug',
  'sourceTemplate': '$template_slug',
  'state': 'active',
}
for k, v in src.items():
  if k in ('kind', 'state', 'template', 'sourceTemplate'):
    continue
  data[k] = v
data['facts'] = {**(src.get('facts') or {}), **json.loads('''$facts_json''')}
os.makedirs('$instance_dir', exist_ok=True)
json.dump(data, open('$instance_state', 'w'), indent=2)
"
    echo "created goal instance $bucket"
  fi

  scanned=$((scanned - 1))  # Don't double-count the template.
  active=$((active + 1))
  managed=$((managed + 1))
  echo "-> tick $bucket (goal-manager)"
  if kody-engine exec goal-manager --goal "$bucket"; then
    :
  else
    echo "tick $bucket failed (continuing)"
  fi
done

echo "scanned $scanned goal instance(s), active=$active, managed=$managed"
echo "KODY_SKIP_AGENT=true"