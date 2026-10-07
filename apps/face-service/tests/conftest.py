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
            RawFace(bbox=(10.0, 10.0, 50.0, 60.0), det_score=0.9, embedding=unit(1)),  # 40x50 (area 2000)
            RawFace(bbox=(100.0, 100.0, 220.0, 200.0), det_score=0.8, embedding=unit(2)),  # 120x100 (area 12000)
            RawFace(bbox=(300.0, 300.0, 310.0, 312.0), det_score=0.95, embedding=unit(3)),  # 10x12: below default min_size
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


@pytest.fixture(scope="session")
def real_analyzer():
    root = _model_root()
    pack = os.path.join(root, "models", os.environ.get("MODEL_NAME", "buffalo_l"))
    if not os.path.isdir(pack):
        pytest.skip(f"model pack not found at {pack}; set MODEL_ROOT (run scripts/download_models.py --root <dir>)")
    try:
        from app.engine import InsightFaceAnalyzer

        return InsightFaceAnalyzer(model_name=os.environ.get("MODEL_NAME", "buffalo_l"), root=root, det_size=640)
    except Exception as exc:  # pragma: no cover - depends on the machine
        pytest.skip(f"could not load the insightface model: {exc!r}")


@pytest.fixture(scope="session")
def real_liveness():
    root = _model_root()
    path = os.environ.get("LIVENESS_MODEL") or os.path.join(root, "antispoof", "AntiSpoofing_bin_1.5_128.onnx")
    lv = load_liveness(path)
    return lv


@pytest.fixture(scope="session")
def real_client(real_analyzer, real_liveness):
    from fastapi.testclient import TestClient

    app = create_app(analyzer=real_analyzer, liveness=real_liveness, settings=Settings())
    with TestClient(app) as c:
        yield c
