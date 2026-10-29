FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive UV_PYTHON_INSTALL_DIR=/opt/python UV_PROJECT_ENVIRONMENT=/opt/venv
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git ffmpeg libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.27 /uv /uvx /bin/
WORKDIR /app/worker
COPY pyproject.toml uv.lock ./
RUN uv --no-config python install 3.12 && uv --no-config sync --frozen --no-dev --no-install-project
COPY flowblock_worker ./flowblock_worker
COPY models/manifest.json models/LICENSE.sam2 models/LICENSE.cctorch ./models/
RUN uv --no-config sync --frozen --no-dev && uv --no-config run --no-sync flowblock-worker setup-model
ENV PATH=/opt/venv/bin:$PATH FLOWBLOCK_DEVICE=cuda FLOWBLOCK_STORAGE_DIR=/data/media FLOWBLOCK_HEALTH_HOST=0.0.0.0 PYTHONUNBUFFERED=1
RUN useradd --uid 10001 --create-home worker && mkdir -p /data/media && chown -R worker:worker /data /app/worker/vendor
USER worker
RUN python -c "from flowblock_worker.model import verified_paths; verified_paths()"
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD curl -fsS http://127.0.0.1:8091/readyz || exit 1
CMD ["flowblock-worker", "serve", "--device", "cuda"]
