# kody-litellm: always-on LiteLLM proxy AND the warm-pool owner.
#
# Previously a pure-Python litellm[proxy] container. It now also runs the
# pool owner (`kody pool-serve`), which supervises the LiteLLM child and
# serves the dashboard's claim API. So the image is Node-based (for the
# engine) with litellm pip-installed into a venv — same shape as the runner
# image (kody2/runner/Dockerfile).
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      python3 \
      python3-venv \
      python3-pip \
    && rm -rf /var/lib/apt/lists/*

# LiteLLM in an isolated venv; `litellm` on PATH for the pool owner to spawn.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir 'litellm[proxy]'
ENV PATH="/opt/venv/bin:${PATH}"

# The Kody engine provides `kody pool-serve` (the owner). Pin via build arg;
# defaults to latest so a fresh build picks up the newest published engine.
ARG KODY_ENGINE_VERSION=latest
RUN npm install -g @kody-ade/kody-engine@${KODY_ENGINE_VERSION}

WORKDIR /app

# Static wildcard config — keys come from env (Fly secrets). The pool owner
# spawns: litellm --config /app/config.yaml --port 4000 --host 0.0.0.0
COPY config.yaml /app/config.yaml

# Pool owner serves on 4100 (public, authed); litellm on 4000 (6PN internal).
EXPOSE 4000 4100

# Health check hits the pool owner's /healthz (which also reports litellm).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:4100/healthz >/dev/null || exit 1

# `kody pool-serve` is PID 1: it supervises the litellm child and serves the
# pool API. A pool-owner crash restarts via Fly; litellm is restarted in-proc.
ENTRYPOINT ["kody", "pool-serve"]
