# Frames of Me face service. Build context is apps/face-service:
#   docker build -t rephoto-face-service apps/face-service
# The model pack (~280 MB download, ~190 MB kept) and the anti-spoofing weights are fetched
# at build time into /models, so the running container needs no network access.
#   --build-arg WITH_LIVENESS=0   skips the anti-spoofing weights (/v1/liveness -> method "none")

FROM python:3.11-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /build
COPY requirements.txt requirements-insightface.txt ./
RUN pip install -r requirements.txt && pip install --no-deps -r requirements-insightface.txt

ARG MODEL_NAME=buffalo_l
ARG WITH_LIVENESS=1
COPY scripts/download_models.py scripts/download_models.py
RUN python scripts/download_models.py --root /models --model "$MODEL_NAME" --liveness "$WITH_LIVENESS"

FROM python:3.11-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group --create-home --shell /usr/sbin/nologin face
COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=root:root /models /models
WORKDIR /srv
COPY --chown=root:root app ./app

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    MODEL_ROOT=/models \
    MODEL_NAME=buffalo_l \
    DET_SIZE=1024 \
    DET_LONG_EDGE=2560 \
    MODEL_CONCURRENCY=2 \
    DECODE_CONCURRENCY=4 \
    UVICORN_WORKERS=1 \
    HOME=/home/face

USER face
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4).status == 200 else 1)"
# UVICORN_WORKERS processes, each with its own model copy (~1-1.5 GB RSS each) and its own
# MODEL_CONCURRENCY semaphore. `exec` keeps uvicorn as PID 1 so signals reach it directly.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8090 --workers \"${UVICORN_WORKERS:-1}\" --no-server-header"]
