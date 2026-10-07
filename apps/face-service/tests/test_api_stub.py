import math

import pytest

from app import images
from app.main import MAX_UPLOAD_BYTES
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
    assert set(face) == {"bbox", "score", "quality", "embedding"}
    assert set(face["bbox"]) == {"left", "top", "width", "height"}
    assert face["bbox"]["width"] == pytest.approx(120 / 400)  # largest first
    assert len(face["embedding"]) == 512
    assert math.isclose(math.sqrt(sum(v * v for v in face["embedding"])), 1.0, abs_tol=1e-5)
    assert 0 <= face["score"] <= 1 and 0 <= face["quality"] <= 1
    assert stub.calls == [(400, 400)]


def test_embed_query_params(client):
    r = client.post("/v1/embed?max_faces=1&min_size=1", files={"image": ("p.png", make_image(400, 400, "PNG"), "image/png")})
    assert r.status_code == 200 and len(r.json()["faces"]) == 1
    r = client.post("/v1/embed?min_size=1", files={"image": ("p.png", make_image(400, 400, "PNG"), "image/png")})
    assert len(r.json()["faces"]) == 3


def test_embed_reports_original_size_when_downscaled(client, stub):
    r = client.post("/v1/embed", files={"image": ("p.jpg", make_image(3200, 1600), "image/jpeg")})
    assert r.status_code == 200
    assert (r.json()["width"], r.json()["height"]) == (3200, 1600)
    assert stub.calls == [(1600, 800)]  # the analyser saw the scaled image


@pytest.mark.parametrize("query", ["max_faces=0", "max_faces=51", "min_size=0", "max_faces=abc"])
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
