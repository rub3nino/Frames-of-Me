"""Protocol tests against the real insightface model. Skipped when the model pack cannot be
loaded (see conftest.real_analyzer); run with MODEL_ROOT=<dir with models/buffalo_l>.

Fixtures: `scripts/loadtest/fixtures/sample.jpg` is the repo's synthetic 640x480 gradient
(no face, by design); the face photos are the ones bundled with the insightface package
(`t1.jpg`, a group photo, and a 112 px single-face crop)."""

import io
import math
import os
import time

import pytest
from PIL import Image

from app.liveness import NoLiveness
from tests.conftest import SAMPLE_JPG, make_image


def _insightface_image(name: str) -> bytes:
    import insightface

    path = os.path.join(os.path.dirname(insightface.__file__), "data", "images", name)
    if not os.path.exists(path):
        pytest.skip(f"bundled insightface image missing: {path}")
    with open(path, "rb") as fh:
        return fh.read()


def _resized_jpeg(data: bytes, long_edge: int) -> bytes:
    img = Image.open(io.BytesIO(data)).convert("RGB")
    s = long_edge / max(img.size)
    img = img.resize((round(img.width * s), round(img.height * s)), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return buf.getvalue()


@pytest.fixture(scope="session")
def sample_bytes():
    if not os.path.exists(SAMPLE_JPG):
        pytest.skip(f"fixture missing: {SAMPLE_JPG}")
    with open(SAMPLE_JPG, "rb") as fh:
        return fh.read()


@pytest.fixture(scope="session")
def group_bytes():
    return _insightface_image("t1.jpg")  # 1280x886, several faces


@pytest.fixture(scope="session")
def portrait_bytes():
    """The bundled 112x112 aligned crop pasted on a 3x larger canvas (a bare aligned crop is
    tighter than anything a camera produces and SCRFD does not detect it)."""
    crop = Image.open(io.BytesIO(_insightface_image("Tom_Hanks_54745.png"))).convert("RGB")
    canvas = Image.new("RGB", (crop.width * 3, crop.height * 3), (120, 120, 120))
    canvas.paste(crop, (crop.width, crop.height))
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def _timed(client, path, data, **params):
    t0 = time.perf_counter()
    r = client.post(path, params=params, files={"image": ("p.jpg", data, "image/jpeg")})
    return r, (time.perf_counter() - t0) * 1000


def test_health_real(real_client):
    body = real_client.get("/health").json()
    assert body["ok"] is True and body["model"] == os.environ.get("MODEL_NAME", "buffalo_l")
    assert "CPUExecutionProvider" in body["providers"]


def test_embed_group_photo(real_client, group_bytes):
    r, _ = _timed(real_client, "/v1/embed", group_bytes)
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["width"], body["height"]) == (1280, 886)
    assert len(body["faces"]) >= 3
    areas = []
    for f in body["faces"]:
        b = f["bbox"]
        assert 0 <= b["left"] <= 1 and 0 <= b["top"] <= 1
        assert 0 < b["width"] <= 1 and 0 < b["height"] <= 1
        assert b["left"] + b["width"] <= 1 + 1e-6 and b["top"] + b["height"] <= 1 + 1e-6
        assert 0 <= f["score"] <= 1 and 0 <= f["quality"] <= 1
        assert len(f["embedding"]) == 512
        assert math.isclose(math.sqrt(sum(v * v for v in f["embedding"])), 1.0, abs_tol=1e-4)
        areas.append(b["width"] * b["height"])
    assert areas == sorted(areas, reverse=True)
    r1 = real_client.post("/v1/embed", params={"max_faces": 1}, files={"image": ("p.jpg", group_bytes, "image/jpeg")}).json()
    assert len(r1["faces"]) == 1 and r1["faces"][0]["bbox"] == body["faces"][0]["bbox"]


def test_embed_single_small_face(real_client, portrait_bytes):
    r = real_client.post("/v1/embed", files={"image": ("p.png", portrait_bytes, "image/png")})
    assert r.status_code == 200, r.text
    faces = r.json()["faces"]
    assert len(faces) == 1
    assert faces[0]["quality"] <= faces[0]["score"]  # quality = min(1, px/80) * score
    b = faces[0]["bbox"]
    assert 0.25 < b["left"] + b["width"] / 2 < 0.75 and 0.25 < b["top"] + b["height"] / 2 < 0.75  # centred


def test_embeddings_separate_identities(real_client, group_bytes, portrait_bytes):
    """Same photo twice -> cosine ~1; different people -> clearly lower."""
    a = real_client.post("/v1/embed", files={"image": ("p.jpg", group_bytes, "image/jpeg")}).json()["faces"]
    b = real_client.post("/v1/embed", files={"image": ("p.jpg", group_bytes, "image/jpeg")}).json()["faces"]
    same = sum(x * y for x, y in zip(a[0]["embedding"], b[0]["embedding"]))
    assert same > 0.999
    other = sum(x * y for x, y in zip(a[0]["embedding"], a[1]["embedding"]))
    assert other < 0.45  # two different people in the group photo


def test_embed_no_face(real_client, sample_bytes):
    r, _ = _timed(real_client, "/v1/embed", sample_bytes)
    assert r.status_code == 200
    assert r.json() == {"width": 640, "height": 480, "faces": []}
    r2 = real_client.post("/v1/embed", files={"image": ("p.jpg", make_image(640, 480, "JPEG", color=(90, 120, 200)), "image/jpeg")})
    assert r2.json()["faces"] == []


def test_embed_latency(real_client, sample_bytes, group_bytes, capsys):
    real_client.post("/v1/embed", files={"image": ("p.jpg", group_bytes, "image/jpeg")})  # warm-up
    cases = {
        "sample.jpg 640x480 no face": sample_bytes,
        "group 1280px": group_bytes,
        "group 1600px": _resized_jpeg(group_bytes, 1600),
        "group 4000px (resized to 1600 by the service)": _resized_jpeg(group_bytes, 4000),
    }
    with capsys.disabled():
        print()
        for label, data in cases.items():
            times = []
            faces = 0
            for _ in range(5):
                r, ms = _timed(real_client, "/v1/embed", data)
                assert r.status_code == 200
                faces = len(r.json()["faces"])
                times.append(ms)
            print(f"[latency] /v1/embed {label}: faces={faces} min {min(times):.0f} ms, avg {sum(times) / len(times):.0f} ms (5 runs, {len(data) // 1024} KB)")


def test_liveness_real(real_client, real_liveness, group_bytes, sample_bytes, capsys):
    r, ms = _timed(real_client, "/v1/liveness", group_bytes)
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"live", "score", "method"}
    if isinstance(real_liveness, NoLiveness):
        assert body == {"live": True, "score": 0.0, "method": "none"}
        return
    assert body["method"] == "silent-face"
    assert 0 <= body["score"] <= 1
    assert isinstance(body["live"], bool)
    r2 = real_client.post("/v1/liveness", files={"image": ("p.jpg", sample_bytes, "image/jpeg")})
    assert r2.json() == {"live": False, "score": 0.0, "method": "silent-face"}  # no face -> not live
    with capsys.disabled():
        print(f"\n[latency] /v1/liveness group photo: {ms:.0f} ms -> {body}")
