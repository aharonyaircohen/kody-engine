#!/usr/bin/env bash
set -euo pipefail

# Entrypoint for the kody-litellm machine (pool owner + LiteLLM proxy).
#
# Fly's private 6PN network is IPv6-only. LiteLLM's proxy binds IPv4
# (0.0.0.0:4000) and does not reliably bind IPv6, so kody-litellm.internal:4000
# is unreachable from runner machines over 6PN. Bridge it: socat listens on
# IPv6 [::]:4000 and forwards to LiteLLM on 127.0.0.1:4000. ipv6only=1 lets it
# coexist with LiteLLM's IPv4 0.0.0.0:4000 on the same port.
#
# LITELLM_HOST=0.0.0.0 (set as a Fly env) keeps LiteLLM IPv4-only so it does
# not contend with socat for [::]:4000. The pool owner (kody pool-serve) reads
# LITELLM_HOST when it spawns the proxy.

echo "→ kody-litellm: starting IPv6 bridge [::]:4000 → 127.0.0.1:4000"
socat "TCP6-LISTEN:4000,reuseaddr,fork,ipv6only=1" "TCP4:127.0.0.1:4000" \
  >>/tmp/socat-litellm.log 2>&1 &

exec kody pool-serve
