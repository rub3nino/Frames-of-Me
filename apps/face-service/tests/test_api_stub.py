import math
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

from app import images
from app.main import MAX_FACES_CAP, MAX_UPLOAD_BYTES, Metrics, Settings
from tests.conftest import make_image


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "model": "stub", "providers": ["CPUExecutionProvider"]}


def test_health_503_when_model_missing():
    from fastapi.testclient import TestClient

    from app.main import Settings, create_app

    app = create_app(analyzer=None, liveness=None, settings=Settings())
    # no lifespan -> nothing loaded
    r = TestClient(app).get("/health")
    assert r.status_code == 503 and r.json()["ok"] is False


def test_embed_shape_and_order(client, stub):
    r = client.post("/v1/embed", files={"image": ("photo.jpg", make_image(400, 400), "image/jpeg")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"width", "height", "faces"}
    assert (body["width"], body["height"]) == (400, 400)
    assert len(body["faces"]) == 2  # min_size default 20 drops the 10x12 face
    face = body["faces"][0]
    assert set(face) == {"bbox", "score", "quality", "embedding", "norm", "yaw"}
    assert set(face["bbox"]) == {"left", "top", "width", "height"}
    assert face["bbox"]["width"] == pytest.approx(120 / 400)  # largest first
    assert len(face["embedding"]) == 512
    assert math.isclose(math.sqrt(sum(v * v for v in face["embedding"])), 1.0, abs_tol=1e-5)
    assert 0 <= face["score"] <= 1 and 0 <= face["quality"] <= 1
    assert face["norm"] > 1.5 and face["yaw"] == pytest.approx(0.5)  # nose towards the image right
    assert body["faces"][1]["yaw"] == pytest.approx(0.0)
    assert stub.calls == [(400, 400)]


def test_yaw_is_null_without_landmarks(client):
    r = client.post("/v1/embed?min_size=1", files={"image": ("p.png", make_image(400, 400, "PNG"), "image/png")})
    assert [f["yaw"] for f in r.json()["faces"]] == [pytest.approx(0.5), pytest.approx(0.0), None]


def test_embed_query_params(client):
    r = client.post("/v1/embed?max_faces=1&min_size=1", files={"image": ("p.png", make_image(400, 400, "PNG"), "image/png")})
    assert r.status_code == 200 and len(r.json()["faces"]) == 1
    r = client.post("/v1/embed?min_size=1", files={"image": ("p.png", make_image(400, 400, "PNG"), "image/png")})
    assert len(r.json()["faces"]) == 3


def test_embed_reports_original_size_when_downscaled(client, stub):
    r = client.post("/v1/embed", files={"image": ("p.jpg", make_image(5120, 2560), "image/jpeg")})
    assert r.status_code == 200
    assert (r.json()["width"], r.json()["height"]) == (5120, 2560)
    assert stub.calls == [(2560, 1280)]  # the analyser saw the image scaled to DET_LONG_EDGE (2560)


def test_embed_uses_settings_det_long_edge(stub):
    from fastapi.testclient import TestClient

    from app.liveness import NoLiveness
    from app.main import create_app

    app = create_app(analyzer=stub, liveness=NoLiveness(), settings=Settings(det_long_edge=1600))
    with TestClient(app) as c:
        r = c.post("/v1/embed", files={"image": ("p.jpg", make_image(3200, 1600), "image/jpeg")})
    assert r.status_code == 200 and (r.json()["width"], r.json()["height"]) == (3200, 1600)
    assert stub.calls == [(1600, 800)]


def test_max_faces_cap_is_150(client):
    assert MAX_FACES_CAP == 150
    ok = client.post("/v1/embed?max_faces=150", files={"image": ("p.jpg", make_image(40, 40), "image/jpeg")})
    assert ok.status_code == 200
    r = client.post("/v1/embed?max_faces=151", files={"image": ("p.jpg", make_image(40, 40), "image/jpeg")})
    assert r.status_code == 422


def test_settings_from_env(monkeypatch):
    for name in ("DET_SIZE", "DET_LONG_EDGE", "MODEL_CONCURRENCY", "DECODE_CONCURRENCY", "UVICORN_WORKERS", "ONNX_THREADS"):
        monkeypatch.delenv(name, raising=False)
    s = Settings.from_env()
    assert (s.det_size, s.det_long_edge, s.model_concurrency, s.decode_concurrency, s.uvicorn_workers, s.onnx_threads) == (1024, 2560, 2, 4, 1, 0)
    monkeypatch.setenv("DET_SIZE", "640")
    monkeypatch.setenv("DET_LONG_EDGE", "1600")
    monkeypatch.setenv("MODEL_CONCURRENCY", "3")
    monkeypatch.setenv("DECODE_CONCURRENCY", "8")
    monkeypatch.setenv("UVICORN_WORKERS", "2")
    s = Settings.from_env()
    assert (s.det_size, s.det_long_edge, s.model_concurrency, s.decode_concurrency, s.uvicorn_workers) == (640, 1600, 3, 8, 2)
    monkeypatch.setenv("MODEL_CONCURRENCY", "0")
    with pytest.raises(ValueError):
        Settings.from_env()


def test_concurrency_semaphores_follow_settings(stub):
    from app.liveness import NoLiveness
    from app.main import create_app

    app = create_app(analyzer=stub, liveness=NoLiveness(), settings=Settings(model_concurrency=3, decode_concurrency=5))
    assert app.state.model_semaphore._value == 3
    assert app.state.decode_semaphore._value == 5


def test_decode_semaphore_bounds_parallel_decodes(stub, monkeypatch):
    """With DECODE_CONCURRENCY=1 two concurrent requests never decode at the same time."""
    import threading

    from fastapi.testclient import TestClient

    from app import main as main_mod
    from app.liveness import NoLiveness
    from app.main import create_app

    active = 0
    peak = 0
    lock = threading.Lock()
    real = main_mod.decode_or_raise

    def slow_decode(data, **kw):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            time.sleep(0.05)
            return real(data, **kw)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(main_mod, "decode_or_raise", slow_decode)
    app = create_app(analyzer=stub, liveness=NoLiveness(), settings=Settings(decode_concurrency=1))
    blob = make_image(200, 200)
    with TestClient(app) as c:
        with ThreadPoolExecutor(4) as pool:
            codes = list(pool.map(lambda _: c.post("/v1/embed", files={"image": ("p.jpg", blob, "image/jpeg")}).status_code, range(4)))
    assert codes == [200] * 4
    assert peak == 1


def test_metrics_plain_text(client, stub):
    blob = make_image(400, 400)
    for _ in range(3):
        assert client.post("/v1/embed", files={"image": ("p.jpg", blob, "image/jpeg")}).status_code == 200
    client.post("/v1/embed", files={"image": ("p.jpg", b"garbage", "image/jpeg")})  # 400 -> error counter
    r = client.get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    lines = dict(line.split(" ", 1) for line in r.text.strip().splitlines())
    assert lines["face_service_model"] == "stub"
    assert lines["face_service_uvicorn_workers"] == "1"
    assert lines["face_service_det_size"] == "1024" and lines["face_service_det_long_edge"] == "2560"
    assert lines["face_service_embed_requests_total"] == "3"
    assert lines["face_service_embed_errors_total"] == "1"
    assert lines["face_service_embed_faces_detected_total"] == "9"
    assert lines["face_service_embed_faces_returned_total"] == "6"  # 2 per call pass min_size
    assert lines["face_service_embed_latency_window"] == "3"
    assert float(lines["face_service_embed_latency_ms_p95"]) >= float(lines["face_service_embed_latency_ms_p50"]) >= 0
    assert lines["face_service_liveness_requests_total"] == "0"


def test_metrics_percentiles_window_of_500():
    m = Metrics()
    for i in range(600):
        m.record_embed(float(i), detected=1, returned=1)
    text = m.render(model="x", settings=Settings(), providers=["CPUExecutionProvider"])
    lines = dict(line.split(" ", 1) for line in text.strip().splitlines())
    assert lines["face_service_embed_latency_window"] == "500"
    assert lines["face_service_embed_requests_total"] == "600"
    assert float(lines["face_service_embed_latency_ms_p50"]) == pytest.approx(100 + 0.5 * 499, abs=1)
    assert float(lines["face_service_embed_latency_ms_p95"]) == pytest.approx(100 + 0.95 * 499, abs=1)
    assert float(lines["face_service_embed_latency_ms_max"]) == 599.0


def test_metrics_before_model_loaded():
    from fastapi.testclient import TestClient

    from app.main import create_app

    app = create_app(analyzer=None, liveness=None, settings=Settings())
    r = TestClient(app).get("/metrics")
    assert r.status_code == 200 and "face_service_model buffalo_l" in r.text


@pytest.mark.parametrize("query", ["max_faces=0", "max_faces=151", "min_size=0", "max_faces=abc"])
def test_422_on_bad_query(client, query):
    r = client.post(f"/v1/embed?{query}", files={"image": ("p.jpg", make_image(20, 20), "image/jpeg")})
    assert r.status_code == 422


def test_422_when_image_field_missing(client):
    r = client.post("/v1/embed", files={"photo": ("p.jpg", make_image(20, 20), "image/jpeg")})
    assert r.status_code == 422


def test_400_on_undecodable(client):
    r = client.post("/v1/embed", files={"image": ("p.jpg", b"definitely not an image", "image/jpeg")})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "undecodable_image"


def test_400_on_unsupported_format(client):
    r = client.post("/v1/embed", files={"image": ("p.gif", make_image(20, 20, "GIF"), "image/gif")})
    assert r.status_code == 400


def test_413_on_too_many_bytes(client):
    blob = b"\xff" * (MAX_UPLOAD_BYTES + 1)
    r = client.post("/v1/embed", files={"image": ("p.jpg", blob, "image/jpeg")})
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "payload_too_large"


def test_413_on_declared_length_before_parsing(client, stub):
    # A Content-Length above the limit is refused by the middleware: the body is never parsed
    # and the analyser never runs (httpx keeps an explicit Content-Length header).
    r = client.post(
        "/v1/embed",
        content=b"--x\r\n",
        headers={"content-type": "multipart/form-data; boundary=x", "content-length": str(MAX_UPLOAD_BYTES * 4)},
    )
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "payload_too_large"
    assert stub.calls == []


def test_413_on_too_many_pixels(client, monkeypatch):
    monkeypatch.setattr(images, "MAX_PIXELS", 500)
    r = client.post("/v1/embed", files={"image": ("p.png", make_image(40, 40, "PNG"), "image/png")})
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "image_too_large"


def test_liveness_none(client):
    r = client.post("/v1/liveness", files={"image": ("p.jpg", make_image(64, 64), "image/jpeg")})
    assert r.status_code == 200
    assert r.json() == {"live": True, "score": 0.0, "method": "none"}


def test_liveness_errors(client):
    assert client.post("/v1/liveness", files={"image": ("p.jpg", b"nope", "image/jpeg")}).status_code == 400
    assert client.post("/v1/liveness", files={"image": ("p.jpg", b"\xff" * (MAX_UPLOAD_BYTES + 1), "image/jpeg")}).status_code == 413
    assert client.post("/v1/liveness").status_code == 422
