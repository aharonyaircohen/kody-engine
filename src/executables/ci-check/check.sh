#!/usr/bin/env bash
# ci-check: read PR CI checks via gh and emit capability report lines.
set -euo pipefail

PR="${KODY_ARG_PR:-}"
GOAL="${KODY_ARG_GOAL:-}"
EVIDENCE="${KODY_ARG_EVIDENCE:-}"
TIMEOUT="${KODY_ARG_TIMEOUT_SECONDS:-0}"

if [[ -z "$PR" ]]; then
  echo "KODY_REASON=missing --pr"
  exit 1
fi

# Fetch CI checks via gh pr checks (returns JSON array).
checks_json=$(gh pr checks "$PR" --json name,workflow,bucket,state 2>/dev/null || echo "[]")

# Aggregate.
read ci_status ci_pass ci_fail ci_pending ci_total ci_detail <<<"$(python3 -c "
import json, sys
data = json.loads('''$checks_json''')
if not data:
  print('unknown 0 0 0 0 ')
  sys.exit(0)
buckets = {'pass': 0, 'fail': 0, 'pending': 0, 'skipping': 0, 'cancel': 0}
for c in data:
  b = (c.get('bucket') or '').lower()
  if b in buckets: buckets[b] += 1
total = len(data)
if buckets['fail'] > 0:
  status = 'red'
  detail = next((c.get('workflow','') for c in data if (c.get('bucket') or '').lower() == 'fail'), '')
elif buckets['pending'] > 0 or buckets['skipping'] > 0:
  status = 'pending'
  detail = next((c.get('workflow','') for c in data if (c.get('bucket') or '').lower() in ('pending','skipping')), '')
else:
  status = 'green'
  detail = ''
print(f'{status} {buckets[\"pass\"]} {buckets[\"fail\"]} {buckets[\"pending\"]} {total} {detail}')
")"

# Determine evidence value.
if [[ "$ci_status" == "green" ]]; then
  evidence_value="true"
  result_status="pass"
  summary="CI green on PR #$PR ($ci_total checks)"
  reason="CI green on PR #$PR"
elif [[ "$ci_status" == "pending" ]]; then
  evidence_value="false"
  result_status="blocked"
  summary="CI pending on PR #$PR: $ci_detail"
  reason="CI pending on PR #$PR: $ci_detail"
else
  evidence_value="false"
  result_status="fail"
  summary="CI red on PR #$PR"
  reason="CI red on PR #$PR"
fi

# Emit capability report lines.
printf 'KODY_CAPABILITY_REPORT={"target":{"type":"goal","id":"%s"},"evidence":{"%s":%s},"facts":{"pr":%s,"ciStatus":"%s","ciChecks":%s' \
  "$GOAL" "$EVIDENCE" "$evidence_value" "$PR" "$ci_status" "$ci_total"
if [[ "$ci_status" == "pending" ]]; then
  printf ',"ciPending":%s,"ciDetail":"%s"' "$ci_pending" "$ci_detail"
fi
printf '}}\n'

printf 'KODY_CAPABILITY_RESULT={"version":1,"status":"%s","summary":"%s","facts":{"pr":%s,"ciStatus":"%s","ciChecks":%s' \
  "$result_status" "$summary" "$PR" "$ci_status" "$ci_total"
if [[ "$ci_status" == "pending" ]]; then
  printf ',"ciPending":%s,"ciDetail":"%s"' "$ci_pending" "$ci_detail"
fi
printf '}}\n'

echo "KODY_REASON=$reason"
echo "KODY_SKIP_AGENT=true"
