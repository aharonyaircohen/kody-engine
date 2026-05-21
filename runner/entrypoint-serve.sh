#!/usr/bin/env bash
set -euo pipefail

# Entrypoint for a WARM-POOL runner machine (runner-serve mode).
#
# Unlike entrypoint.sh, no REPO/ISSUE_NUMBER is known at boot — the machine
# is generic, gets frozen, and receives its job over HTTP after wake. This
# entrypoint only:
#   1. Establishes the always-on LiteLLM forward (localhost:4000 → the shared
#      kody-litellm proxy) once, so per-job runs skip the ~24s spawn.
#   2. Execs `kody runner-serve`, which listens until it gets a job.
#
# Expected env (set by the pool owner at create time):
#   RUNNER_API_KEY   bearer key the pool owner uses to POST /run (required)
#   KODY_LITELLM_URL always-on LiteLLM proxy (e.g. http://kody-litellm.internal:4000)
#   PORT             listen port (default 8080)

: "${RUNNER_API_KEY:?RUNNER_API_KEY is required}"

LITELLM_PORT=4000

# Forward localhost:4000 → the always-on proxy with socat so the engine's
# checkLitellmHealth() succeeds against localhost without a per-job spawn.
# Mirrors entrypoint.sh's KODY_LITELLM_URL branch.
if [ -n "${KODY_LITELLM_URL:-}" ]; then
  if command -v socat >/dev/null 2>&1; then
    target_host="$(echo "$KODY_LITELLM_URL" | sed -E 's#^https?://([^:/]+).*#\1#')"
    target_port="$(echo "$KODY_LITELLM_URL" | sed -nE 's#^https?://[^:]+:([0-9]+).*#\1#p')"
    target_port="${target_port:-4000}"
    if [ -n "$target_host" ]; then
      echo "→ runner-serve: forwarding localhost:${LITELLM_PORT} → ${target_host}:${target_port} (always-on litellm)"
      socat "TCP-LISTEN:${LITELLM_PORT},reuseaddr,fork" \
            "TCP:${target_host}:${target_port}" \
            >>/tmp/socat.log 2>&1 &
    else
      echo "→ runner-serve: KODY_LITELLM_URL malformed ('${KODY_LITELLM_URL}') — skipping forward"
    fi
  else
    echo "→ runner-serve: socat missing — skipping litellm forward"
  fi
fi

exec kody runner-serve
