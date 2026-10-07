import math

import numpy as np
import pytest

from app.engine import RawFace, build_faces, estimate_yaw, largest_face
from tests.conftest import kps, unit


def test_bbox_normalised_and_sorted_by_area(stub):
    faces = build_faces(stub.faces, 400, 400, min_size=20, max_faces=50)
    assert len(faces) == 2  # the 10x12 face is dropped
    first, second = faces
    assert first.bbox.left == pytest.approx(100 / 400)
    assert first.bbox.top == pytest.approx(100 / 400)
    assert first.bbox.width == pytest.approx(120 / 400)
    assert first.bbox.height == pytest.approx(100 / 400)
    assert second.bbox.width == pytest.approx(40 / 400)


def test_embedding_is_l2_normalised(stub):
    faces = build_faces(stub.faces, 400, 400, min_size=1, max_faces=50)
    for f in faces:
        assert len(f.embedding) == 512
        assert math.isclose(math.sqrt(sum(v * v for v in f.embedding)), 1.0, abs_tol=1e-5)


def test_quality_formula(stub):
    faces = build_faces(stub.faces, 400, 400, min_size=1, max_faces=50)
    by_width = {round(f.bbox.width * 400): f for f in faces}
    assert by_width[120].quality == pytest.approx(min(1.0, 120 / 80) * 0.8)  # capped at 1 -> 0.8
    assert by_width[40].quality == pytest.approx((50 / 80) * 0.9)
    assert by_width[10].quality == pytest.approx((12 / 80) * 0.95)
    assert by_width[120].score == pytest.approx(0.8)


def test_min_size_uses_long_edge(stub):
    assert len(build_faces(stub.faces, 400, 400, min_size=12, max_faces=50)) == 3
    assert len(build_faces(stub.faces, 400, 400, min_size=13, max_faces=50)) == 2
    assert len(build_faces(stub.faces, 400, 400, min_size=51, max_faces=50)) == 1


def test_max_faces_keeps_largest(stub):
    faces = build_faces(stub.faces, 400, 400, min_size=1, max_faces=1)
    assert len(faces) == 1 and round(faces[0].bbox.width * 400) == 120


def test_bbox_is_clamped_to_image():
    raw = [RawFace(bbox=(-20.0, -10.0, 60.0, 50.0), det_score=1.2, embedding=unit(9))]
    (f,) = build_faces(raw, 100, 100, min_size=1, max_faces=5)
    assert (f.bbox.left, f.bbox.top) == (0.0, 0.0)
    assert f.bbox.width == pytest.approx(0.6) and f.bbox.height == pytest.approx(0.5)
    assert f.score == 1.0  # clamped


def test_degenerate_and_zero_embeddings_are_dropped():
    raw = [
        RawFace(bbox=(50.0, 50.0, 40.0, 60.0), det_score=0.9, embedding=unit(1)),  # inverted bbox
        RawFace(bbox=(0.0, 0.0, 50.0, 50.0), det_score=0.9, embedding=np.zeros(512, dtype=np.float32)),
    ]
    assert build_faces(raw, 100, 100, min_size=1, max_faces=5) == []


def test_wrong_embedding_size_raises():
    raw = [RawFace(bbox=(0.0, 0.0, 50.0, 50.0), det_score=0.9, embedding=np.ones(128, dtype=np.float32))]
    with pytest.raises(ValueError):
        build_faces(raw, 100, 100, min_size=1, max_faces=5)


def test_largest_face(stub):
    assert largest_face([]) is None
    assert largest_face(stub.faces).bbox == (100.0, 100.0, 220.0, 200.0)


def test_norm_is_the_pre_normalisation_l2(stub):
    faces = build_faces(stub.faces, 400, 400, min_size=1, max_faces=50)
    by_width = {round(f.bbox.width * 400): f for f in faces}
    assert by_width[120].norm == pytest.approx(float(np.linalg.norm(unit(2))), rel=1e-5)
    assert by_width[120].norm > 1.5  # the raw vector is deliberately not unit length


def test_yaw_sign_positive_towards_image_right():
    # eyes 40 px apart, nose 20 px to the right of the eye centre -> +0.5
    assert estimate_yaw(kps((20.0, 25.0), (60.0, 25.0), (60.0, 40.0))) == pytest.approx(0.5)
    # nose to the left of the eye centre -> negative
    assert estimate_yaw(kps((20.0, 25.0), (60.0, 25.0), (20.0, 40.0))) == pytest.approx(-0.5)
    # frontal
    assert estimate_yaw(kps((20.0, 25.0), (60.0, 25.0), (40.0, 40.0))) == pytest.approx(0.0)
    # mirrored landmarks mirror the sign
    k = kps((20.0, 25.0), (60.0, 25.0), (52.0, 40.0))
    mirrored = k.copy()
    mirrored[:, 0] = 100.0 - mirrored[:, 0]
    mirrored[[0, 1]] = mirrored[[1, 0]]  # the detector would re-label the eyes after a flip
    assert estimate_yaw(mirrored) == pytest.approx(-estimate_yaw(k))


def test_yaw_is_clamped_and_robust():
    assert estimate_yaw(kps((20.0, 25.0), (30.0, 25.0), (90.0, 40.0))) == 1.0
    assert estimate_yaw(kps((20.0, 25.0), (30.0, 25.0), (-90.0, 40.0))) == -1.0
    assert estimate_yaw(None) is None
    assert estimate_yaw(kps((25.0, 25.0), (25.0, 25.0), (25.0, 40.0))) is None  # coincident eyes
    assert estimate_yaw(np.zeros((3, 2))) is None  # wrong shape
    assert estimate_yaw(kps((20.0, 25.0), (60.0, 25.0), (float("nan"), 40.0))) is None


def test_build_faces_carries_yaw(stub):
    faces = build_faces(stub.faces, 400, 400, min_size=1, max_faces=50)
    by_width = {round(f.bbox.width * 400): f for f in faces}
    assert by_width[120].yaw == pytest.approx(0.5)
    assert by_width[40].yaw == pytest.approx(0.0)
    assert by_width[10].yaw is None
