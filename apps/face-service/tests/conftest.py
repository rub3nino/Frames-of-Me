from __future__ import annotations

import io
import os

import numpy as np
import pytest
from PIL import Image

from app.engine import RawFace
from app.liveness import NoLiveness, load_liveness
from app.main import Settings, create_app

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SAMPLE_JPG = os.path.join(REPO_ROOT, "scripts", "loadtest", "fixtures", "sample.jpg")


def make_image(width: int, height: int, fmt: str = "JPEG", color=(200, 180, 160), orientation: int | None = None) -> bytes:
    img = Image.new("RGB", (width, height), color)
    buf = io.BytesIO()
    kwargs = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[0x0112] = orientation
        kwargs["exif"] = exif.tobytes()
    img.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def unit(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(512).astype(np.float32)
    return v * 3.7  # deliberately not unit length


def kps(left_eye, right_eye, nose, mouth_l=None, mouth_r=None) -> np.ndarray:
    """Five SCRFD landmarks in insightface order (left eye, right eye, nose, mouth corners)."""
    mouth_l = mouth_l or (left_eye[0], nose[1] + 10.0)
    mouth_r = mouth_r or (right_eye[0], nose[1] + 10.0)
    return np.asarray([left_eye, right_eye, nose, mouth_l, mouth_r], dtype=np.float32)


class StubAnalyzer:
    """Returns a fixed list of detections regardless of the image."""

    model_name = "stub"
    providers = ["CPUExecutionProvider"]

    def __init__(self, faces: list[RawFace] | None = None) -> None:
        self.faces = faces or []
        self.calls: list[tuple[int, int]] = []

    def analyze(self, bgr):
        self.calls.append((bgr.shape[1], bgr.shape[0]))
        return list(self.faces)


@pytest.fixture
def stub() -> StubAnalyzer:
    return StubAnalyzer(
        faces=[
            # 40x50 (area 2000), frontal: nose on the eye centre -> yaw 0
            RawFace(bbox=(10.0, 10.0, 50.0, 60.0), det_score=0.9, embedding=unit(1), kps=kps((20.0, 25.0), (40.0, 25.0), (30.0, 40.0))),
            # 120x100 (area 12000), nose 20 px right of the eye centre over a 40 px eye distance -> yaw +0.5
            RawFace(bbox=(100.0, 100.0, 220.0, 200.0), det_score=0.8, embedding=unit(2), kps=kps((140.0, 130.0), (180.0, 130.0), (180.0, 160.0))),
            # 10x12: below default min_size; no landmarks -> yaw None
            RawFace(bbox=(300.0, 300.0, 310.0, 312.0), det_score=0.95, embedding=unit(3)),
        ]
    )


@pytest.fixture
def client(stub):
    from fastapi.testclient import TestClient

    app = create_app(analyzer=stub, liveness=NoLiveness(), settings=Settings())
    with TestClient(app) as c:
        yield c


# ---- real model (only when a model root with buffalo_l is available) ----


def _model_root() -> str:
    return os.environ.get("MODEL_ROOT") or os.path.expanduser("~/.insightface")


REAL_DET_SIZE = int(os.environ.get("DET_SIZE", "1024"))
REAL_LONG_EDGE = int(os.environ.get("DET_LONG_EDGE", "2560"))
LEGACY_DET_SIZE, LEGACY_LONG_EDGE = 640, 1600  # the v4 defaults, kept for the resolution comparison


def _load_real_analyzer(det_size: int):
    root = _model_root()
    pack = os.path.join(root, "models", os.environ.get("MODEL_NAME", "buffalo_l"))
    if not os.path.isdir(pack):
        pytest.skip(f"model pack not found at {pack}; set MODEL_ROOT (run scripts/download_models.py --root <dir>)")
    try:
        from app.engine import InsightFaceAnalyzer

        return InsightFaceAnalyzer(model_name=os.environ.get("MODEL_NAME", "buffalo_l"), root=root, det_size=det_size)
    except Exception as exc:  # pragma: no cover - depends on the machine
        pytest.skip(f"could not load the insightface model: {exc!r}")


@pytest.fixture(scope="session")
def real_analyzer():
    return _load_real_analyzer(REAL_DET_SIZE)


@pytest.fixture(scope="session")
def legacy_analyzer():
    """Second model instance with the v4 detector input (640) for the 1600/640 vs 2560/1024 comparison."""
    return _load_real_analyzer(LEGACY_DET_SIZE)


@pytest.fixture(scope="session")
def real_liveness():
    root = _model_root()
    path = os.environ.get("LIVENESS_MODEL") or os.path.join(root, "antispoof", "AntiSpoofing_bin_1.5_128.onnx")
    lv = load_liveness(path)
    return lv


@pytest.fixture(scope="session")
def real_client(real_analyzer, real_liveness):
    from fastapi.testclient import TestClient

    app = create_app(analyzer=real_analyzer, liveness=real_liveness, settings=Settings(det_size=REAL_DET_SIZE, det_long_edge=REAL_LONG_EDGE))
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def legacy_client(legacy_analyzer):
    from fastapi.testclient import TestClient

    app = create_app(analyzer=legacy_analyzer, liveness=NoLiveness(), settings=Settings(det_size=LEGACY_DET_SIZE, det_long_edge=LEGACY_LONG_EDGE))
    with TestClient(app) as c:
        yield c
