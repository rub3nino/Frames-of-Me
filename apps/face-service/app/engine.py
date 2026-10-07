"""Face detection and ArcFace embeddings.

`InsightFaceAnalyzer` wraps insightface's SCRFD detector and the w600k_r50 recogniser
from the `buffalo_l` pack. `build_faces` is the pure post-processing step (bbox
normalisation, quality, ordering) and is what the stubbed tests exercise.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol, Sequence

import numpy as np

EMBEDDING_DIM = 512
QUALITY_REF_PX = 80.0  # a face whose long edge is >= 80 px gets full resolution credit


@dataclass(frozen=True)
class RawFace:
    """One detection as produced by an analyser.

    `bbox` is (x1, y1, x2, y2) in pixels of the image passed to `analyze`. `embedding`
    has any norm; it is L2-normalised by `build_faces`. `kps` are the five SCRFD landmarks
    (left eye, right eye, nose, left mouth corner, right mouth corner) as a (5, 2) array
    in the same pixel space, or None.
    """

    bbox: tuple[float, float, float, float]
    det_score: float
    embedding: np.ndarray
    kps: np.ndarray | None = None


class Analyzer(Protocol):
    model_name: str
    providers: list[str]

    def analyze(self, bgr: np.ndarray) -> list[RawFace]: ...


@dataclass(frozen=True)
class BBox:
    left: float
    top: float
    width: float
    height: float


@dataclass(frozen=True)
class FaceResult:
    bbox: BBox
    score: float
    quality: float
    embedding: list[float]
    norm: float  # L2 norm of the raw ArcFace embedding before normalisation (a weak quality cue)
    yaw: float | None  # see `estimate_yaw`; None when the detector gave no landmarks


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def estimate_yaw(kps: np.ndarray | None) -> float | None:
    """Cheap head-yaw proxy from the five landmarks, in [-1, 1].

    (nose.x - eye_centre.x) / inter-eye distance, clamped. Sign convention: **positive when
    the nose points towards the right edge of the image** (the subject's left as they face
    the camera), negative towards the left edge; ~0 is frontal. |yaw| around 0.5 is already
    a strong three-quarter view. Returns None without landmarks or with coincident eyes.
    """

    if kps is None:
        return None
    pts = np.asarray(kps, dtype=np.float64)
    if pts.shape != (5, 2) or not np.all(np.isfinite(pts)):
        return None
    left_eye, right_eye, nose = pts[0], pts[1], pts[2]
    eye_dist = float(np.hypot(*(right_eye - left_eye)))
    if eye_dist <= 1e-6:
        return None
    centre_x = (left_eye[0] + right_eye[0]) / 2.0
    return _clamp((float(nose[0]) - centre_x) / eye_dist, -1.0, 1.0)


def largest_face(raw: Sequence[RawFace]) -> RawFace | None:
    if not raw:
        return None
    return max(raw, key=lambda f: max(0.0, f.bbox[2] - f.bbox[0]) * max(0.0, f.bbox[3] - f.bbox[1]))


def build_faces(raw: Sequence[RawFace], img_w: int, img_h: int, *, min_size: int, max_faces: int) -> list[FaceResult]:
    """Normalise detections to the 0..1 bbox convention, compute quality, drop faces whose
    long edge is below `min_size` px, sort by bbox area (desc) and keep `max_faces`."""

    if img_w <= 0 or img_h <= 0:
        raise ValueError("image dimensions must be positive")
    scored: list[tuple[float, FaceResult]] = []
    for face in raw:
        x1 = _clamp(float(face.bbox[0]), 0.0, img_w)
        y1 = _clamp(float(face.bbox[1]), 0.0, img_h)
        x2 = _clamp(float(face.bbox[2]), 0.0, img_w)
        y2 = _clamp(float(face.bbox[3]), 0.0, img_h)
        w, h = x2 - x1, y2 - y1
        if w <= 0 or h <= 0:
            continue
        long_edge = max(w, h)
        if long_edge < min_size:
            continue
        score = _clamp(float(face.det_score), 0.0, 1.0)
        quality = min(1.0, long_edge / QUALITY_REF_PX) * score

        emb = np.asarray(face.embedding, dtype=np.float32).reshape(-1)
        if emb.shape[0] != EMBEDDING_DIM:
            raise ValueError(f"embedding has {emb.shape[0]} dims, expected {EMBEDDING_DIM}")
        norm = float(np.linalg.norm(emb))
        if not np.isfinite(norm) or norm == 0.0:
            continue
        unit = (emb / norm).astype(np.float32)

        result = FaceResult(
            bbox=BBox(left=x1 / img_w, top=y1 / img_h, width=w / img_w, height=h / img_h),
            score=score,
            quality=quality,
            embedding=[float(v) for v in unit],
            norm=norm,
            yaw=estimate_yaw(face.kps),
        )
        scored.append((w * h, result))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [result for _, result in scored[:max_faces]]


def default_threads() -> int:
    try:
        return max(1, len(os.sched_getaffinity(0)))  # honours cgroup/taskset limits on Linux
    except AttributeError:
        return max(1, os.cpu_count() or 1)


class InsightFaceAnalyzer:
    """SCRFD detection + ArcFace recognition from a local insightface model pack."""

    def __init__(self, *, model_name: str = "buffalo_l", root: str = "/models", det_size: int = 640, threads: int | None = None) -> None:
        import onnxruntime as ort
        from insightface.app import FaceAnalysis

        threads = threads or default_threads()
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self._app = FaceAnalysis(
            name=model_name,
            root=root,
            allowed_modules=["detection", "recognition"],
            providers=["CPUExecutionProvider"],
            sess_options=so,
        )
        self._app.prepare(ctx_id=-1, det_size=(det_size, det_size))
        if "recognition" not in self._app.models:
            raise RuntimeError(f"model pack {model_name!r} has no recognition model")
        self._rec = self._app.models["recognition"]
        self.model_name = model_name
        self.det_size = det_size
        self.threads = threads
        self.providers = list(self._app.det_model.session.get_providers())

    def analyze(self, bgr: np.ndarray) -> list[RawFace]:
        from insightface.app.common import Face

        bboxes, kpss = self._app.det_model.detect(bgr, max_num=0, metric="default")
        out: list[RawFace] = []
        for i in range(bboxes.shape[0]):
            kps = kpss[i] if kpss is not None else None
            face = Face(bbox=bboxes[i, 0:4], kps=kps, det_score=float(bboxes[i, 4]))
            self._rec.get(bgr, face)
            out.append(RawFace(bbox=tuple(float(v) for v in bboxes[i, 0:4]), det_score=float(bboxes[i, 4]), embedding=np.asarray(face.embedding), kps=kps))
        return out
