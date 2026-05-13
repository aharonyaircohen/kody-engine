FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production

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

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
