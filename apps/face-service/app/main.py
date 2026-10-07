"""RePhoto face service: FastAPI front for insightface (SCRFD + ArcFace) on CPU.

Endpoints (see README.md):
  GET  /health        -> { ok, model, providers }
  POST /v1/embed      -> { width, height, faces: [{ bbox, score, quality, embedding }] }
  POST /v1/liveness   -> { live, score, method }

No persistence; image bytes are never logged.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .engine import Analyzer, InsightFaceAnalyzer, build_faces, default_threads, largest_face
from .images import ImageTooLarge, ImageUndecodable, decode_image
from .liveness import DEFAULT_MODEL_FILENAME, DEFAULT_THRESHOLD, NoLiveness, SilentFaceLiveness, load_liveness

log = logging.getLogger("face-service")

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
# Whole request (multipart framing included) above which the body is refused before it is
# parsed: Starlette would otherwise spool the entire upload before the route sees it.
MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024
MAX_FACES_LIMIT = 50
MODEL_CONCURRENCY = 2


@dataclass(frozen=True)
class Settings:
    model_name: str = "buffalo_l"
    model_root: str = "/models"
    onnx_threads: int = 0  # 0 = CPU count
    det_size: int = 640
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
            onnx_threads=int(os.environ.get("ONNX_THREADS", "0") or 0),
            det_size=int(os.environ.get("DET_SIZE", "640")),
            liveness_model=liveness or None,
            liveness_threshold=float(os.environ.get("LIVENESS_THRESHOLD", str(DEFAULT_THRESHOLD))),
        )


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


def decode_or_raise(data: bytes):
    try:
        return decode_image(data)
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
            log.info("model %s loaded in %.1fs (det_size=%d, threads=%d, providers=%s)", settings.model_name, time.perf_counter() - t0, settings.det_size, threads, app.state.analyzer.providers)
        if app.state.liveness is None:
            app.state.liveness = load_liveness(settings.liveness_model, threshold=settings.liveness_threshold, threads=threads)
            log.info("liveness method: %s", app.state.liveness.method)
        yield

    app = FastAPI(title="RePhoto face service", version="1.0.0", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.analyzer = analyzer
    app.state.liveness = liveness
    app.state.model_semaphore = asyncio.Semaphore(MODEL_CONCURRENCY)
    app.add_middleware(BodySizeLimit)

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

    @app.post("/v1/embed", response_model=EmbedOut)
    async def embed(
        request: Request,
        image: UploadFile = File(...),
        max_faces: int = Query(MAX_FACES_LIMIT, ge=1, le=MAX_FACES_LIMIT),
        min_size: int = Query(20, ge=1, le=10_000),
    ) -> Any:
        an: Analyzer | None = app.state.analyzer
        if an is None:
            raise api_error(503, "model_not_loaded", "face model is not loaded")
        data = await read_upload(image, request)
        t0 = time.perf_counter()
        decoded = await asyncio.to_thread(decode_or_raise, data)
        del data
        async with app.state.model_semaphore:
            raw = await asyncio.to_thread(an.analyze, decoded.bgr)
        faces = build_faces(raw, decoded.scaled_width, decoded.scaled_height, min_size=min_size, max_faces=max_faces)
        log.info("embed %dx%d detected=%d returned=%d %.0fms", decoded.width, decoded.height, len(raw), len(faces), (time.perf_counter() - t0) * 1000)
        return EmbedOut(
            width=decoded.width,
            height=decoded.height,
            faces=[FaceOut(bbox=BBoxOut(**vars(f.bbox)), score=f.score, quality=f.quality, embedding=f.embedding) for f in faces],
        )

    @app.post("/v1/liveness", response_model=LivenessOut)
    async def liveness_check(request: Request, image: UploadFile = File(...)) -> Any:
        lv = app.state.liveness
        an: Analyzer | None = app.state.analyzer
        if lv is None or an is None:
            raise api_error(503, "model_not_loaded", "face model is not loaded")
        data = await read_upload(image, request)
        decoded = await asyncio.to_thread(decode_or_raise, data)
        del data
        if isinstance(lv, NoLiveness):
            r = lv.predict(decoded.bgr, None)
            return LivenessOut(live=r.live, score=r.score, method=r.method)
        t0 = time.perf_counter()
        async with app.state.model_semaphore:
            raw = await asyncio.to_thread(an.analyze, decoded.bgr)
            face = largest_face(raw)
            r = await asyncio.to_thread(lv.predict, decoded.bgr, face.bbox if face else None)
        log.info("liveness faces=%d live=%s score=%.3f %.0fms", len(raw), r.live, r.score, (time.perf_counter() - t0) * 1000)
        return LivenessOut(live=r.live, score=r.score, method=r.method)

    return app


app = create_app()
