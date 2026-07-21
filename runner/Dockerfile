FROM node:22-bookworm-slim

# NOTE: do NOT set NODE_ENV=production here. The runner clones user repos and
# runs their quality gate (typecheck/lint/tests). With NODE_ENV=production,
# React ships its production build, `react-dom/test-utils` drops `act`, and
# every @testing-library component test fails ("React.act is not a function")
# — which silently fails the engine's verify gate so no PR is ever opened.
# Each tool sets the NODE_ENV it needs (vitest=test, `next build`=production).
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      ca-certificates \
      curl \
      python3 \
      python3-pip \
      python3-venv \
      jq \
      openssh-client \
      socat \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — the engine shells out to `gh` for labels, comments, and PR
# creation in agent mode (kody run). Pinned binary install avoids adding
# an apt repo + key. Update the version pin manually when needed.
ARG GH_VERSION=2.62.0
RUN ARCH=$(dpkg --print-architecture) \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    | tar -xz -C /tmp \
 && mv "/tmp/gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/gh \
 && rm -rf "/tmp/gh_${GH_VERSION}_linux_${ARCH}"

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir 'litellm[proxy]'
ENV PATH="/opt/venv/bin:${PATH}"

ARG KODY_ENGINE_VERSION=latest
RUN npm install -g @kody-ade/kody-engine@${KODY_ENGINE_VERSION}
# The published bin is `kody-engine`; entrypoint.sh / entrypoint-serve.sh
# invoke bare `kody`. Symlink so both resolve (older images shipped a `kody`
# bin; this restores that name after the rename).
RUN ln -sf "$(npm root -g)/@kody-ade/kody-engine/dist/bin/kody.js" /usr/local/bin/kody

# Package managers — the engine's preflight + verify shell out to whatever
# the cloned repo uses (pnpm/yarn/npm). Corepack ships with Node 22 and
# shims all three so the right one is on PATH. Pin pnpm 10 because pnpm 11 is
# outside the engine range used by supported repositories and would make their
# frozen install fail before Kody can run.
RUN corepack enable \
 && corepack prepare pnpm@10 --activate

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# entrypoint-serve.sh is the warm-pool variant: boots `kody runner-serve`
# (idle, no issue baked in) instead of running one issue. The pool owner
# overrides the machine entrypoint to this when creating pooled machines;
# the default one-shot ENTRYPOINT below is unchanged.
COPY entrypoint-serve.sh /usr/local/bin/entrypoint-serve.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/entrypoint-serve.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
