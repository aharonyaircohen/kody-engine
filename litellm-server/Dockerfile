FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir 'litellm[proxy]'

WORKDIR /app

# Static wildcard config — keys come from env (Fly secrets).
COPY config.yaml /app/config.yaml

EXPOSE 4000

# Health check uses LiteLLM's /health/liveliness endpoint (cheap, no provider call).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -sf http://localhost:4000/health/liveliness >/dev/null || exit 1

CMD ["litellm", "--config", "/app/config.yaml", "--port", "4000", "--host", "0.0.0.0"]
