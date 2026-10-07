"""Frames of Me face service: FastAPI front for insightface (SCRFD + ArcFace) on CPU.

Endpoints (see README.md):
  GET  /health        -> { ok, model, providers }
  GET  /metrics       -> plain text counters and latency percentiles (no Prometheus client)
  POST /v1/embed      -> { width, height, faces: [{ bbox, score, quality, embedding, norm, yaw }] }
  POST /v1/liveness   -> { live, score, method }

No persistence; image bytes are never logged.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .engine import Analyzer, InsightFaceAnalyzer, build_faces, default_threads, largest_face
from .images import DEFAULT_LONG_EDGE, ImageTooLarge, ImageUndecodable, _env_int, decode_image
from .liveness import DEFAULT_MODEL_FILENAME, DEFAULT_THRESHOLD, NoLiveness, SilentFaceLiveness, load_liveness

log = logging.getLogger("face-service")

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
# Whole request (multipart framing included) above which the body is refused before it is
# parsed: Starlette would otherwise spool the entire upload before the route sees it.
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024
# Hard cap on `max_faces` (query 1..MAX_FACES_CAP, default = cap). A 2560 px hall photo can
# legitimately hold 100+ detectable faces; each one costs an ArcFace pass (~10 ms).
MAX_FACES_CAP = 150
MAX_FACES_LIMIT = MAX_FACES_CAP  # backwards-compatible alias
DEFAULT_DET_SIZE = 1024
DEFAULT_MODEL_CONCURRENCY = 2
DEFAULT_DECODE_CONCURRENCY = 4
LATENCY_WINDOW = 500


@dataclass(frozen=True)
class Settings:
    model_name: str = "buffalo_l"
    model_root: str = "/models"
    onnx_threads: int = 0  # 0 = CPU count
    det_size: int = DEFAULT_DET_SIZE  # SCRFD input edge (square)
    det_long_edge: int = DEFAULT_LONG_EDGE  # long edge of the image handed to the detector
    model_concurrency: int = DEFAULT_MODEL_CONCURRENCY  # concurrent inferences per worker process
    decode_concurrency: int = DEFAULT_DECODE_CONCURRENCY  # concurrent Pillow decodes per worker process
    uvicorn_workers: int = 1  # informational (the Dockerfile CMD reads UVICORN_WORKERS itself)
    liveness_model: str | None = None
    liveness_threshold: float = DEFAULT_THRESHOLD

    @classmethod
    def from_env(cls) -> "Settings":
        root = os.environ.get("MODEL_ROOT", "/models")
        liveness = os.environ.get("LIVENESS_MODEL")
        if liveness is None:
            liveness = os.path.join(root, DEFAULT_MODEL_FILENAME)
        return cls(
            model_name=os.environ.get("MODEL_NAME", "buffalo_l"),
            model_root=root,
            onnx_threads=_env_int("ONNX_THREADS", 0, minimum=0),
            det_size=_env_int("DET_SIZE", DEFAULT_DET_SIZE, minimum=32),
            det_long_edge=_env_int("DET_LONG_EDGE", DEFAULT_LONG_EDGE, minimum=32),
            model_concurrency=_env_int("MODEL_CONCURRENCY", DEFAULT_MODEL_CONCURRENCY),
            decode_concurrency=_env_int("DECODE_CONCURRENCY", DEFAULT_DECODE_CONCURRENCY),
            uvicorn_workers=_env_int("UVICORN_WORKERS", 1),
            liveness_model=liveness or None,
            liveness_threshold=float(os.environ.get("LIVENESS_THRESHOLD", str(DEFAULT_THRESHOLD))),
        )


class Metrics:
    """Process-local counters for /metrics. With UVICORN_WORKERS > 1 each worker process has
    its own instance, so a scrape reflects the worker that answered it."""

    def __init__(self, window: int = LATENCY_WINDOW) -> None:
        self._lock = threading.Lock()
        self.started_at = time.time()
        self.embed_requests = 0
        self.embed_errors = 0
        self.faces_detected = 0
        self.faces_returned = 0
        self.liveness_requests = 0
        self.liveness_errors = 0
        self.embed_latency_ms: deque[float] = deque(maxlen=window)
        self.liveness_latency_ms: deque[float] = deque(maxlen=window)

    def record_embed(self, ms: float, *, detected: int, returned: int) -> None:
        with self._lock:
            self.embed_requests += 1
            self.faces_detected += detected
            self.faces_returned += returned
            self.embed_latency_ms.append(ms)

    def record_liveness(self, ms: float) -> None:
        with self._lock:
            self.liveness_requests += 1
            self.liveness_latency_ms.append(ms)

    def record_error(self, endpoint: str) -> None:
        with self._lock:
            if endpoint == "embed":
                self.embed_errors += 1
            else:
                self.liveness_errors += 1

    @staticmethod
    def _percentile(values: list[float], pct: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        idx = max(0, min(len(ordered) - 1, round((len(ordered) - 1) * pct)))
        return ordered[idx]

    def render(self, *, model: str, settings: Settings, providers: list[str]) -> str:
        with self._lock:
            embed = list(self.embed_latency_ms)
            live = list(self.liveness_latency_ms)
            counters = (
                self.embed_requests,
                self.embed_errors,
                self.faces_detected,
                self.faces_returned,
                self.liveness_requests,
                self.liveness_errors,
            )
        embed_req, embed_err, detected, returned, live_req, live_err = counters
        lines = [
            f"face_service_model {model}",
            f"face_service_providers {','.join(providers) or '-'}",
            f"face_service_uvicorn_workers {settings.uvicorn_workers}",
            f"face_service_model_concurrency {settings.model_concurrency}",
            f"face_service_decode_concurrency {settings.decode_concurrency}",
            f"face_service_det_size {settings.det_size}",
            f"face_service_det_long_edge {settings.det_long_edge}",
            f"face_service_uptime_seconds {time.time() - self.started_at:.0f}",
            f"face_service_embed_requests_total {embed_req}",
            f"face_service_embed_errors_total {embed_err}",
            f"face_service_embed_faces_detected_total {detected}",
            f"face_service_embed_faces_returned_total {returned}",
            f"face_service_embed_latency_window {len(embed)}",
            f"face_service_embed_latency_ms_p50 {self._percentile(embed, 0.50):.1f}",
            f"face_service_embed_latency_ms_p95 {self._percentile(embed, 0.95):.1f}",
            f"face_service_embed_latency_ms_max {max(embed) if embed else 0.0:.1f}",
            f"face_service_liveness_requests_total {live_req}",
            f"face_service_liveness_errors_total {live_err}",
            f"face_service_liveness_latency_ms_p50 {self._percentile(live, 0.50):.1f}",
            f"face_service_liveness_latency_ms_p95 {self._percentile(live, 0.95):.1f}",
        ]
        return "\n".join(lines) + "\n"


# ---- response models (the wire contract, see docs/v4-selfhost-spec.md §1) ----


class BBoxOut(BaseModel):
    left: float
    top: float
    width: float
    height: float


class FaceOut(BaseModel):
    bbox: BBoxOut
    score: float
    quality: float
    embedding: list[float] = Field(min_length=512, max_length=512)
    norm: float  # L2 norm of the raw embedding before normalisation
    yaw: float | None  # [-1, 1]; positive = nose towards the image's right edge; None without landmarks


class EmbedOut(BaseModel):
    width: int
    height: int
    faces: list[FaceOut]


class LivenessOut(BaseModel):
    live: bool
    score: float
    method: str


class HealthOut(BaseModel):
    ok: bool
    model: str
    providers: list[str]


def api_error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


async def read_upload(upload: UploadFile, request: Request) -> bytes:
    """Read at most MAX_UPLOAD_BYTES; reject early on Content-Length when present."""

    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_REQUEST_BYTES:
        raise api_error(413, "payload_too_large", f"image must be at most {MAX_UPLOAD_BYTES} bytes")
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise api_error(413, "payload_too_large", f"image must be at most {MAX_UPLOAD_BYTES} bytes")
        chunks.append(chunk)
    if total == 0:
        raise api_error(400, "empty_image", "image field is empty")
    return b"".join(chunks)


def decode_or_raise(data: bytes, *, max_long_edge: int | None = None):
    try:
        return decode_image(data, max_long_edge=max_long_edge)
    except ImageTooLarge as exc:
        raise api_error(413, "image_too_large", str(exc)) from exc
    except ImageUndecodable as exc:
        raise api_error(400, "undecodable_image", str(exc)) from exc


class BodySizeLimit:
    """ASGI middleware: 413 on a declared Content-Length above MAX_REQUEST_BYTES, before the
    multipart body is read or spooled. Chunked bodies are still bounded by read_upload."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            declared = next((v for k, v in scope.get("headers", []) if k == b"content-length"), b"")
            if declared.isdigit() and int(declared) > MAX_REQUEST_BYTES:
                response = JSONResponse(
                    status_code=413,
                    content={"detail": {"code": "payload_too_large", "message": f"image must be at most {MAX_UPLOAD_BYTES} bytes"}},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(*, analyzer: Analyzer | None = None, liveness: NoLiveness | SilentFaceLiveness | None = None, settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        threads = settings.onnx_threads or default_threads()
        if app.state.analyzer is None:
            t0 = time.perf_counter()
            app.state.analyzer = await asyncio.to_thread(
                InsightFaceAnalyzer,
                model_name=settings.model_name,
                root=settings.model_root,
                det_size=settings.det_size,
                threads=threads,
            )
            log.info(
                "model %s loaded in %.1fs (det_size=%d, det_long_edge=%d, threads=%d, model_concurrency=%d, decode_concurrency=%d, providers=%s)",
                settings.model_name,
                time.perf_counter() - t0,
                settings.det_size,
                settings.det_long_edge,
                threads,
                settings.model_concurrency,
                settings.decode_concurrency,
                app.state.analyzer.providers,
            )
        if app.state.liveness is None:
            app.state.liveness = load_liveness(settings.liveness_model, threshold=settings.liveness_threshold, threads=threads)
            log.info("liveness method: %s", app.state.liveness.method)
        yield

    app = FastAPI(title="Frames of Me face service", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.analyzer = analyzer
    app.state.liveness = liveness
    app.state.settings = settings
    app.state.model_semaphore = asyncio.Semaphore(settings.model_concurrency)
    app.state.decode_semaphore = asyncio.Semaphore(settings.decode_concurrency)
    app.state.metrics = Metrics()
    app.add_middleware(BodySizeLimit)

    async def decode_upload(data: bytes):
        # Pillow releases the GIL while decoding, so to_thread gives real parallelism; the
        # semaphore bounds the number of 20 MP decodes (and their ~60 MB buffers) in flight.
        async with app.state.decode_semaphore:
            return await asyncio.to_thread(decode_or_raise, data, max_long_edge=settings.det_long_edge)

    @app.exception_handler(HTTPException)
    async def _http_error(_: Request, exc: HTTPException) -> JSONResponse:
        detail: Any = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse(status_code=exc.status_code, content={"detail": detail})

    @app.get("/health", response_model=HealthOut)
    async def health() -> Any:
        an: Analyzer | None = app.state.analyzer
        if an is None:
            return JSONResponse(status_code=503, content={"ok": False, "model": settings.model_name, "providers": []})
        return HealthOut(ok=True, model=an.model_name, providers=list(an.providers))

    @app.get("/metrics", response_class=PlainTextResponse)
    async def metrics() -> Any:
        an: Analyzer | None = app.state.analyzer
        text = app.state.metrics.render(
            model=an.model_name if an is not None else settings.model_name,
            settings=settings,
            providers=list(an.providers) if an is not None else [],
        )
        return PlainTextResponse(text, media_type="text/plain; version=0.0.4; charset=utf-8")

    @app.post("/v1/embed", response_model=EmbedOut)
    async def embed(
        request: Request,
        image: UploadFile = File(...),
        max_faces: int = Query(MAX_FACES_CAP, ge=1, le=MAX_FACES_CAP),
        min_size: int = Query(20, ge=1, le=10_000),
    ) -> Any:
        an: Analyzer | None = app.state.analyzer
        if an is None:
            raise api_error(503, "model_not_loaded", "face model is not loaded")
        m: Metrics = app.state.metrics
        data = await read_upload(image, request)
        t0 = time.perf_counter()
        try:
            decoded = await decode_upload(data)
            del data
            async with app.state.model_semaphore:
                raw = await asyncio.to_thread(an.analyze, decoded.bgr)
        except Exception:
            m.record_error("embed")
            raise
        faces = build_faces(raw, decoded.scaled_width, decoded.scaled_height, min_size=min_size, max_faces=max_faces)
        ms = (time.perf_counter() - t0) * 1000
        m.record_embed(ms, detected=len(raw), returned=len(faces))
        log.info("embed %dx%d detected=%d returned=%d %.0fms", decoded.width, decoded.height, len(raw), len(faces), ms)
        return EmbedOut(
            width=decoded.width,
            height=decoded.height,
            faces=[
                FaceOut(bbox=BBoxOut(**vars(f.bbox)), score=f.score, quality=f.quality, embedding=f.embedding, norm=f.norm, yaw=f.yaw)
                for f in faces
            ],
        )

    @app.post("/v1/liveness", response_model=LivenessOut)
    async def liveness_check(request: Request, image: UploadFile = File(...)) -> Any:
        lv = app.state.liveness
        an: Analyzer | None = app.state.analyzer
        if lv is None or an is None:
            raise api_error(503, "model_not_loaded", "face model is not loaded")
        m: Metrics = app.state.metrics
        data = await read_upload(image, request)
        try:
            decoded = await decode_upload(data)
        except Exception:
            m.record_error("liveness")
            raise
        del data
        if isinstance(lv, NoLiveness):
            r = lv.predict(decoded.bgr, None)
            return LivenessOut(live=r.live, score=r.score, method=r.method)
        t0 = time.perf_counter()
        try:
            async with app.state.model_semaphore:
                raw = await asyncio.to_thread(an.analyze, decoded.bgr)
                face = largest_face(raw)
                r = await asyncio.to_thread(lv.predict, decoded.bgr, face.bbox if face else None)
        except Exception:
            m.record_error("liveness")
            raise
        ms = (time.perf_counter() - t0) * 1000
        m.record_liveness(ms)
        log.info("liveness faces=%d live=%s score=%.3f %.0fms", len(raw), r.live, r.score, ms)
        return LivenessOut(live=r.live, score=r.score, method=r.method)

    return app


app = create_app()
