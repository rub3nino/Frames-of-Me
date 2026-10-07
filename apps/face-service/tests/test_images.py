import io
import os

import pytest
from PIL import Image

from app import images
from app.images import ImageTooLarge, ImageUndecodable, decode_image
from tests.conftest import make_image


def test_decodes_jpeg_to_bgr():
    d = decode_image(make_image(64, 48, "JPEG", color=(255, 0, 0)))
    assert (d.width, d.height) == (64, 48)
    assert d.bgr.shape == (48, 64, 3)
    assert d.bgr.dtype.name == "uint8"
    # pure red in RGB becomes high value in channel 2 of BGR
    assert d.bgr[0, 0, 2] > 200 and d.bgr[0, 0, 0] < 40


def test_decodes_png():
    d = decode_image(make_image(30, 20, "PNG"))
    assert (d.width, d.height, d.bgr.shape) == (30, 20, (20, 30, 3))


def test_exif_orientation_is_applied():
    d = decode_image(make_image(100, 40, "JPEG", orientation=6))  # rotate 90 CW
    assert (d.width, d.height) == (40, 100)
    assert d.bgr.shape[:2] == (100, 40)


def test_default_long_edge_is_2560():
    assert images.DEFAULT_LONG_EDGE == 2560
    assert images.MAX_LONG_EDGE == 2560 or "DET_LONG_EDGE" in os.environ
    d = decode_image(make_image(5120, 2560, "JPEG"), max_long_edge=2560)
    assert (d.width, d.height) == (5120, 2560)  # original dimensions are reported
    assert d.bgr.shape[1] == 2560 and d.bgr.shape[0] == 1280  # detector image is scaled


def test_long_edge_is_configurable_per_call_and_by_module_default(monkeypatch):
    d = decode_image(make_image(3200, 1600, "JPEG"), max_long_edge=1600)
    assert d.bgr.shape[1] == 1600 and d.bgr.shape[0] == 800
    monkeypatch.setattr(images, "MAX_LONG_EDGE", 800)
    d = decode_image(make_image(3200, 1600, "JPEG"))
    assert d.bgr.shape[1] == 800 and d.bgr.shape[0] == 400
    assert (d.width, d.height) == (3200, 1600)


def test_det_long_edge_env_is_parsed(monkeypatch):
    monkeypatch.setenv("DET_LONG_EDGE", "1600")
    assert images._env_int("DET_LONG_EDGE", 2560) == 1600
    monkeypatch.setenv("DET_LONG_EDGE", "")
    assert images._env_int("DET_LONG_EDGE", 2560) == 2560
    monkeypatch.setenv("DET_LONG_EDGE", "abc")
    with pytest.raises(ValueError):
        images._env_int("DET_LONG_EDGE", 2560)
    monkeypatch.setenv("DET_LONG_EDGE", "0")
    with pytest.raises(ValueError):
        images._env_int("DET_LONG_EDGE", 2560)


@pytest.mark.parametrize(
    ("size", "edge", "expected"),
    [
        ((5568, 3712), 2560, (2560, 1707)),  # 20 MP: JPEG draft decodes at 1/2 (2784 px), then resized
        ((5568, 3712), 1600, (1600, 1067)),  # draft at 1/2 (2784 px) too; 1/4 would be 1392 < 1600
        ((7000, 4000), 2560, (2560, 1463)),  # 1/2 -> 3500 px; 1/4 (1750) would be below the target
        ((7000, 4000), 1600, (1600, 914)),  # 1/4 -> 1750 >= 1600
        ((2000, 1000), 2560, (2000, 1000)),  # no draft, no resize
    ],
)
def test_jpeg_draft_path_yields_exact_edge(size, edge, expected):
    """`draft()` must pick a DCT scale >= the target so the final image is exactly `edge` wide."""
    img = Image.new("RGB", size, (120, 90, 60))
    # draw something non-uniform so the draft + resize is really exercised
    img.paste(Image.new("RGB", (size[0] // 3, size[1] // 3), (10, 200, 30)), (size[0] // 3, size[1] // 3))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    d = decode_image(buf.getvalue(), max_long_edge=edge)
    assert (d.scaled_width, d.scaled_height) == expected
    assert (d.width, d.height) == size
    assert d.bgr[d.scaled_height // 2, d.scaled_width // 2, 1] > 150  # centre is the green patch


def test_small_image_is_not_upscaled():
    d = decode_image(make_image(200, 100, "PNG"))
    assert d.bgr.shape[:2] == (100, 200)


def test_pixel_cap(monkeypatch):
    monkeypatch.setattr(images, "MAX_PIXELS", 1000)
    with pytest.raises(ImageTooLarge):
        decode_image(make_image(40, 40, "PNG"))
    decode_image(make_image(30, 30, "PNG"))  # 900 px: fine
    with pytest.raises(ImageTooLarge):
        decode_image(make_image(40, 40, "PNG"), max_pixels=1599)


@pytest.mark.parametrize("payload", [b"", b"not an image", b"\xff\xd8\xff\xe0 truncated"])
def test_undecodable(payload):
    with pytest.raises(ImageUndecodable):
        decode_image(payload)


def test_unsupported_format_rejected():
    with pytest.raises(ImageUndecodable):
        decode_image(make_image(10, 10, "GIF"))
